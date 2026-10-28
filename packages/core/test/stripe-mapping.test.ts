import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import {
  mapDispute,
  paymentFactFromIntent,
  paymentFactFromInvoice,
  subscriptionFact,
  webhookTarget,
} from '../src/billing/stripe';

const meta = { userId: 'u1', productId: 'pro_month', orderId: 'ord_1', site: 'test' };

describe('Stripe field mapping', () => {
  it('subscription invoice service period comes from line items, not from the invoice period itself', () => {
    const invoice = {
      id: 'in_1',
      status: 'paid',
      amount_paid: 2000,
      currency: 'usd',
      created: 100,
      period_start: 100,
      period_end: 100,
      status_transitions: { paid_at: 150 },
      parent: {
        type: 'subscription_details',
        subscription_details: { metadata: meta, subscription: 'sub_1' },
      },
      lines: { data: [{ period: { start: 1000, end: 3_592_000 } }] },
    } as unknown as Stripe.Invoice;
    const charge = { amount_refunded: 500, created: 150 } as Stripe.Charge;
    const fact = paymentFactFromInvoice(invoice, { id: 'pi_1' } as Stripe.PaymentIntent, charge, []);
    expect(fact).toMatchObject({
      paymentRef: 'in_1',
      chargeRef: 'pi_1',
      paid: true,
      amountRefunded: 500,
      userId: 'u1',
      productId: 'pro_month',
      subscriptionRef: 'sub_1',
      periodStart: 1_000_000,
      periodEnd: 3_592_000_000,
      paidAt: 150_000,
    });
  });

  it('one-time payments use the PaymentIntent as paymentRef and chargeRef', () => {
    const intent = {
      id: 'pi_2',
      status: 'succeeded',
      amount_received: 1000,
      currency: 'usd',
      created: 10,
      metadata: { ...meta, productId: 'pack_100' },
    } as unknown as Stripe.PaymentIntent;
    const fact = paymentFactFromIntent(intent, null, []);
    expect(fact).toMatchObject({
      paymentRef: 'pi_2',
      chargeRef: 'pi_2',
      paid: true,
      productId: 'pack_100',
      orderId: 'ord_1',
    });
  });

  it('dispute status uses the latest one; a closed early warning counts as won', () => {
    const d = (status: string, created: number) => ({ status, created }) as Stripe.Dispute;
    expect(mapDispute([])).toBeNull();
    expect(mapDispute([d('needs_response', 1)])).toBe('open');
    expect(mapDispute([d('lost', 1), d('won', 2)])).toBe('won');
    expect(mapDispute([d('warning_closed', 1)])).toBe('won');
    expect(mapDispute([d('warning_needs_response', 1)])).toBe('open');
  });

  it('subscription period comes from the subscription item', () => {
    const subscription = {
      id: 'sub_1',
      status: 'active',
      cancel_at_period_end: true,
      metadata: meta,
      items: { data: [{ current_period_start: 10, current_period_end: 20 }] },
    } as unknown as Stripe.Subscription;
    expect(subscriptionFact(subscription, 5)).toMatchObject({
      currentPeriodStart: 10_000,
      currentPeriodEnd: 20_000,
      cancelAtPeriodEnd: true,
      fetchedAt: 5,
    });
  });

  it('maps webhook events to the object to fetch', () => {
    const event = (type: string, object: object) =>
      ({ id: 'evt', type, data: { object } }) as unknown as Stripe.Event;
    expect(webhookTarget(event('checkout.session.completed', { id: 'cs_1' }))).toEqual({
      kind: 'checkout',
      ref: 'cs_1',
    });
    expect(webhookTarget(event('invoice.paid', { id: 'in_1' }))).toEqual({ kind: 'payment', ref: 'in_1' });
    expect(webhookTarget(event('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1' }))).toEqual({
      kind: 'charge',
      ref: 'pi_1',
    });
    expect(
      webhookTarget(event('charge.dispute.created', { id: 'dp_1', payment_intent: { id: 'pi_2' } })),
    ).toEqual({
      kind: 'charge',
      ref: 'pi_2',
    });
    expect(webhookTarget(event('customer.subscription.deleted', { id: 'sub_1' }))).toEqual({
      kind: 'subscription',
      ref: 'sub_1',
    });
    expect(webhookTarget(event('payment_intent.created', { id: 'pi_3' }))).toBeNull();
  });
});
