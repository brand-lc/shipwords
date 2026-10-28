import Stripe from 'stripe';
import type {
  CheckoutFact,
  CheckoutRequest,
  PaymentFact,
  PaymentProvider,
  SubscriptionFact,
  WebhookTarget,
  WebhookTrigger,
} from './provider';
import { WebhookSignatureError } from './provider';

// Stripe adapter. Conventions:
// - Prices use inline price_data; no Prices are pre-created in the Stripe dashboard;
// - Our orderId, userId and productId go into metadata on the checkout session, PaymentIntent and Subscription;
// - paymentRef is the PaymentIntent for one-time payments and the Invoice for each subscription period; chargeRef is always the PaymentIntent.

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  automaticTax: boolean;
}

const PROVIDER = 'stripe';

interface OurMetadata {
  userId: string | null;
  productId: string | null;
  orderId: string | null;
}

function readMetadata(metadata: Stripe.Metadata | null | undefined): OurMetadata {
  return {
    userId: metadata?.userId ?? null,
    productId: metadata?.productId ?? null,
    orderId: metadata?.orderId ?? null,
  };
}

const ms = (seconds: number | null | undefined) => (seconds == null ? null : seconds * 1000);
const idOf = (value: string | { id: string } | null | undefined) =>
  value == null ? null : typeof value === 'string' ? value : value.id;

export function mapDispute(disputes: Stripe.Dispute[]): PaymentFact['dispute'] {
  const latest = [...disputes].sort((a, b) => b.created - a.created)[0];
  if (!latest) return null;
  if (latest.status === 'won') return 'won';
  if (latest.status === 'lost') return 'lost';
  // A closed early warning (inquiry) or a prevented dispute means no money was taken, so treat it as won: credits clawed back for the warning are returned.
  // It can't map to null: a payment's dispute status only moves forward (none < open < won/lost).
  if (latest.status === 'warning_closed' || latest.status === 'prevented') return 'won';
  return 'open';
}

/** One-time payment: the PaymentIntent plus its latest Charge and disputes. */
export function paymentFactFromIntent(
  intent: Stripe.PaymentIntent,
  charge: Stripe.Charge | null,
  disputes: Stripe.Dispute[],
): PaymentFact {
  return {
    provider: PROVIDER,
    paymentRef: intent.id,
    chargeRef: intent.id,
    paid: intent.status === 'succeeded',
    amount: intent.amount_received,
    currency: intent.currency,
    amountRefunded: charge?.amount_refunded ?? 0,
    dispute: mapDispute(disputes),
    metadataTrusted: true,
    ...readMetadata(intent.metadata),
    subscriptionRef: null,
    periodStart: null,
    periodEnd: null,
    paidAt: ms(charge?.created ?? intent.created),
    fetchedAt: Date.now(),
  };
}

/** One subscription period: the Invoice, plus refund and dispute status of the PaymentIntent that paid it. */
export function paymentFactFromInvoice(
  invoice: Stripe.Invoice,
  intent: Stripe.PaymentIntent | null,
  charge: Stripe.Charge | null,
  disputes: Stripe.Dispute[],
): PaymentFact | null {
  if (!invoice.id) return null;
  const details = invoice.parent?.subscription_details ?? null;
  const metadata = readMetadata(details?.metadata);
  // The service period is on the line items; the invoice's own period_* is the previous billing period and can't be used.
  let periodStart: number | null = null;
  let periodEnd: number | null = null;
  for (const line of invoice.lines?.data ?? []) {
    if (periodEnd == null || line.period.end * 1000 > periodEnd) {
      periodStart = line.period.start * 1000;
      periodEnd = line.period.end * 1000;
    }
  }
  return {
    provider: PROVIDER,
    paymentRef: invoice.id,
    chargeRef: intent?.id ?? null,
    paid: invoice.status === 'paid',
    amount: invoice.amount_paid,
    currency: invoice.currency,
    amountRefunded: charge?.amount_refunded ?? 0,
    dispute: mapDispute(disputes),
    metadataTrusted: true,
    ...metadata,
    subscriptionRef: details ? idOf(details.subscription) : null,
    periodStart,
    periodEnd,
    paidAt: ms(invoice.status_transitions?.paid_at ?? invoice.created),
    fetchedAt: Date.now(),
  };
}

export function subscriptionFact(subscription: Stripe.Subscription, fetchedAt: number): SubscriptionFact {
  const item = subscription.items.data[0];
  return {
    provider: PROVIDER,
    subscriptionRef: subscription.id,
    ...readMetadata(subscription.metadata),
    status: subscription.status,
    currentPeriodStart: ms(item?.current_period_start),
    currentPeriodEnd: ms(item?.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    fetchedAt,
  };
}

export function webhookTarget(event: Stripe.Event): WebhookTarget | null {
  const object = event.data.object as { id?: string; object?: string; payment_intent?: unknown };
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return object.id ? { kind: 'checkout', ref: object.id } : null;
    case 'invoice.paid':
      return object.id ? { kind: 'payment', ref: object.id } : null;
    case 'charge.refunded':
    case 'charge.refund.updated':
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated': {
      const intent = idOf(object.payment_intent as string | { id: string } | null);
      return intent ? { kind: 'charge', ref: intent } : null;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return object.id ? { kind: 'subscription', ref: object.id } : null;
    default:
      return null;
  }
}

export class StripeProvider implements PaymentProvider {
  readonly name = PROVIDER;
  private readonly stripe: Stripe;

  constructor(
    private readonly options: StripeOptions,
    stripe?: Stripe,
  ) {
    this.stripe = stripe ?? new Stripe(options.secretKey, { httpClient: Stripe.createFetchHttpClient() });
  }

  async createCustomer(user: { id: string; email: string; name: string; siteId: string }): Promise<string> {
    const customer = await this.stripe.customers.create(
      { email: user.email, name: user.name || undefined, metadata: { userId: user.id, site: user.siteId } },
      { idempotencyKey: `customer:${user.siteId}:${user.id}` },
    );
    return customer.id;
  }

  async createCheckout(request: CheckoutRequest): Promise<{ url: string; checkoutRef: string }> {
    const { product } = request;
    const metadata = {
      site: request.siteId,
      userId: request.userId,
      productId: product.id,
      orderId: request.orderId,
    };
    const subscription = product.kind === 'subscription';
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: subscription ? 'subscription' : 'payment',
        customer: request.customerRef,
        client_reference_id: request.orderId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: product.price.currency,
              unit_amount: product.price.amount,
              product_data: { name: product.name },
              ...(subscription ? { recurring: { interval: product.interval } } : {}),
            },
          },
        ],
        metadata,
        ...(subscription ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
        allow_promotion_codes: true,
        ...(this.options.automaticTax
          ? { automatic_tax: { enabled: true }, customer_update: { address: 'auto' as const } }
          : {}),
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
      },
      { idempotencyKey: `checkout:${request.orderId}` },
    );
    if (!session.url) throw new Error('stripe checkout session has no url');
    return { url: session.url, checkoutRef: session.id };
  }

  async parseWebhook(request: Request): Promise<WebhookTrigger> {
    const signature = request.headers.get('stripe-signature');
    if (!signature) throw new WebhookSignatureError('missing stripe-signature header');
    const body = await request.text();
    let event: Stripe.Event;
    try {
      event = await this.stripe.webhooks.constructEventAsync(
        body,
        signature,
        this.options.webhookSecret,
        undefined,
        Stripe.createSubtleCryptoProvider(),
      );
    } catch (error) {
      throw new WebhookSignatureError(error instanceof Error ? error.message : 'invalid signature');
    }
    return { eventId: event.id, type: event.type, target: webhookTarget(event) };
  }

  async fetchCheckout(checkoutRef: string): Promise<CheckoutFact> {
    const session = await this.stripe.checkout.sessions.retrieve(checkoutRef);
    const orderId = session.client_reference_id ?? session.metadata?.orderId ?? null;
    if (session.mode === 'subscription') {
      const subscriptionRef = idOf(session.subscription);
      const invoiceRef = idOf(session.invoice);
      const [subscription, payment] = await Promise.all([
        subscriptionRef ? this.fetchSubscription(subscriptionRef) : null,
        invoiceRef ? this.fetchPayment(invoiceRef) : null,
      ]);
      return { orderId, subscription, payment };
    }
    const intentRef = idOf(session.payment_intent);
    const payment =
      intentRef && session.payment_status === 'paid' ? await this.fetchPayment(intentRef) : null;
    return { orderId, subscription: null, payment };
  }

  async fetchPayment(paymentRef: string): Promise<PaymentFact | null> {
    if (paymentRef.startsWith('in_')) {
      const invoice = await this.stripe.invoices.retrieve(paymentRef, { expand: ['payments'] });
      const paidPayment =
        invoice.payments?.data.find((p) => p.status === 'paid') ?? invoice.payments?.data[0];
      const intentRef = idOf(paidPayment?.payment.payment_intent);
      const { intent, charge, disputes } = intentRef
        ? await this.intentDetails(intentRef)
        : { intent: null, charge: null, disputes: [] };
      return paymentFactFromInvoice(invoice, intent, charge, disputes);
    }
    const { intent, charge, disputes } = await this.intentDetails(paymentRef);
    return paymentFactFromIntent(intent, charge, disputes);
  }

  async fetchPaymentByCharge(chargeRef: string): Promise<PaymentFact | null> {
    // A renewal PaymentIntent belongs to an Invoice; a one-time payment's doesn't.
    const invoicePayments = await this.stripe.invoicePayments.list({
      payment: { type: 'payment_intent', payment_intent: chargeRef },
      limit: 1,
    });
    const invoiceRef = idOf(invoicePayments.data[0]?.invoice as string | { id: string } | undefined);
    return this.fetchPayment(invoiceRef ?? chargeRef);
  }

  async fetchSubscription(subscriptionRef: string): Promise<SubscriptionFact | null> {
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionRef);
    return subscriptionFact(subscription, Date.now());
  }

  async portalUrl(customerRef: string, returnUrl: string): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerRef,
      return_url: returnUrl,
    });
    return session.url;
  }

  async receiptUrl(paymentRef: string): Promise<string | null> {
    // Each subscription period is an Invoice, so use its hosted invoice page; one-time payments use the Charge's receipt page, which also shows refunds.
    if (paymentRef.startsWith('in_')) {
      return (await this.stripe.invoices.retrieve(paymentRef)).hosted_invoice_url ?? null;
    }
    const intent = await this.stripe.paymentIntents.retrieve(paymentRef, { expand: ['latest_charge'] });
    return typeof intent.latest_charge === 'object' ? (intent.latest_charge?.receipt_url ?? null) : null;
  }

  private async intentDetails(intentRef: string) {
    const intent = await this.stripe.paymentIntents.retrieve(intentRef, { expand: ['latest_charge'] });
    const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
    const disputes = charge?.disputed
      ? (await this.stripe.disputes.list({ payment_intent: intentRef, limit: 10 })).data
      : [];
    return { intent, charge, disputes };
  }
}
