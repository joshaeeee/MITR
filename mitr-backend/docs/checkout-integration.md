# Checkout Integration

This checkout is server-authoritative. The browser can display prices and promo
feedback, but it must never send or decide the payable amount.

## Pricing Source

The current Reca frontend branch has price display in `src/lib/product.ts`, with
an optional `NEXT_PUBLIC_PRICE_PAISE` build-time override. That is acceptable only
for display. The amount charged must come from this backend:

- `GET /checkout/product` returns the active product price from Postgres.
- `POST /checkout/orders` recalculates product price, promo discount, final amount,
  and creates the Razorpay order server-side.
- Any amount shown or edited in the browser is ignored by the payment API.

The seeded product is:

- `id`: `reca-suno`
- `name`: `Reca Suno`
- `price_paise`: `499900`
- `mrp_paise`: `1500000`
- `currency`: `INR`

To change production price, update `checkout_products` in Postgres. Do not use a
`NEXT_PUBLIC_*` price variable for the actual charge.

For local Razorpay testing only, the backend supports:

- `CHECKOUT_DEV_PRICE_OVERRIDE_PAISE=100`

This makes the local backend quote and create Razorpay orders for Rs. 1 while
leaving the Postgres product row unchanged. The env is rejected when
`NODE_ENV=production`.

## Vercel / Runtime Env

Frontend Vercel project:

- `NEXT_PUBLIC_MITR_API_BASE_URL=https://<api-host>`
- Do not set Supabase service-role keys in the frontend project.
- Do not set Razorpay secret keys in the frontend project.
- The frontend can read `razorpayKeyId` from `POST /checkout/orders`.

Backend/API runtime:

- `POSTGRES_URL=postgresql://...supabase...?...sslmode=verify-full`
- `CHECKOUT_ENABLED=true`
- `CHECKOUT_DEFAULT_PRODUCT_ID=reca-suno`
- `CHECKOUT_PROMO_RESERVATION_TTL_SEC=2700`
- `RAZORPAY_KEY_ID=...`
- `RAZORPAY_KEY_SECRET=...`
- `RAZORPAY_WEBHOOK_SECRET=...`
- `CORS_ORIGINS=https://<frontend-vercel-domain>`
- `INTERNAL_SERVICE_TOKEN=...`
- `SHORT_CODE_PEPPER=...`

`POSTGRES_URL` is the Supabase Postgres connection string. The browser should not
write orders directly to Supabase.

## Frontend Flow

1. Load product:

   `GET /checkout/product?productId=reca-suno`

2. Validate promo/referral/affiliate code for live UI feedback:

   `POST /checkout/promo/validate`

   ```json
   {
     "code": "WELCOME500",
     "productId": "reca-suno",
     "customerEmail": "buyer@example.com"
   }
   ```

   This response is advisory. The final discount is recomputed when the order is
   created.

3. Create the checkout order before opening Razorpay:

   `POST /checkout/orders`

   ```json
   {
     "idempotencyKey": "browser-generated-uuid-for-this-checkout-attempt",
     "productId": "reca-suno",
     "promoCode": "WELCOME500",
     "personalizedMessage": "Your message",
     "customer": {
       "fullName": "Buyer Name",
       "email": "buyer@example.com",
       "phone": "9999999999",
       "receiveUpdates": true,
       "address": {
         "line1": "House 1",
         "line2": "Street",
         "pinCode": "560001",
         "landmark": "",
         "city": "Bengaluru",
         "state": "Karnataka"
       }
     }
   }
   ```

   Use the returned `razorpayKeyId`, `razorpayOrderId`, `amountPaise`, and
   `currency` to open Razorpay Checkout. Reusing the same `idempotencyKey` returns
   the same order unless the payload changed, in which case the API returns `409`.

4. Verify successful Checkout callback:

   `POST /checkout/verify`

   ```json
   {
     "razorpay_order_id": "order_...",
     "razorpay_payment_id": "pay_...",
     "razorpay_signature": "..."
   }
   ```

   The backend verifies the HMAC signature, fetches the payment from Razorpay, and
   checks order id, amount, currency, and payment status before marking the order
   paid. The legacy `POST /checkout/payments/verify` path is kept as an alias for
   old frontend builds, but new frontend code should use `/checkout/verify`.

5. Configure Razorpay webhook:

   URL: `https://<api-host>/checkout/webhooks/razorpay`

   Subscribe to:

   - `payment.authorized`
   - `payment.captured`
   - `payment.failed`
   - `order.paid`

   Do not enable subscription events for this checkout; this code does not use
   Razorpay Subscriptions. Validly signed but unsupported events are stored and
   acknowledged with HTTP 202 so Razorpay does not treat them as delivery
   failures. Invalid webhook signatures still return HTTP 400.

   The webhook is the source of truth/backstop for closed tabs, network failures,
   and delayed payment status updates. The browser never decides that an order is
   paid. The `/checkout/verify` call only sends Razorpay's Checkout callback IDs
   to the backend, where the HMAC is verified and the payment is fetched from
   Razorpay before any order status changes.

## Adding Codes

Create promo, referral, or affiliate codes through the internal API:

```bash
curl -X POST "$API_BASE_URL/checkout/admin/promo-codes" \
  -H "content-type: application/json" \
  -H "x-internal-service-token: $INTERNAL_SERVICE_TOKEN" \
  -d '{
    "code": "WELCOME500",
    "label": "Rs. 500 off",
    "kind": "promo",
    "discountType": "flat",
    "discountValue": 50000,
    "maxRedemptions": 100,
    "maxRedemptionsPerCustomer": 1,
    "campaign": "launch"
  }'
```

Affiliate example:

```json
{
  "code": "CREATOR10",
  "label": "10 percent off",
  "kind": "affiliate",
  "discountType": "percent",
  "discountValue": 10,
  "maxDiscountPaise": 100000,
  "affiliateId": "creator_123",
  "campaign": "creator_launch"
}
```

When a paid order used a code, attribution is stored on `checkout_orders`:

- `promo_code`
- `promo_kind`
- `affiliate_id`
- `referrer_id`
- `campaign`

## Order States

Useful statuses:

- `draft`: details saved before Razorpay order creation.
- `payment_order_failed`: details saved, Razorpay order creation failed.
- `payment_pending`: Razorpay order exists, payment not completed.
- `payment_signature_failed`: client verification signature was invalid.
- `payment_authorized`: signature valid, payment authorized but not captured.
- `paid`: captured and verified.
- `payment_failed`: Razorpay reported failure.
- `payment_review_required`: signature was valid but amount/currency/order checks
  need manual review.

Abandoned orders:

```sql
select *
from checkout_orders
where status in ('draft', 'payment_order_failed', 'payment_pending', 'payment_signature_failed')
  and paid_at is null
order by created_at desc;
```

Paid attributed sales:

```sql
select promo_code, promo_kind, affiliate_id, referrer_id, campaign, count(*) as orders, sum(amount_paise) as revenue_paise
from checkout_orders
where status = 'paid'
group by promo_code, promo_kind, affiliate_id, referrer_id, campaign
order by orders desc;
```
