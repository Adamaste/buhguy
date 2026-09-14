# FNS API Notes

These notes were extracted from the official `lkdr.nalog.ru` frontend bundle and verified against the live public site HTML and JavaScript assets.

## Base URL

- `https://lkdr.nalog.ru`

## Discovered endpoints

Auth and session:

- `POST /api/v2/auth/challenge/phone/start`
- `POST /api/v1/auth/challenge/phone/verify`
- `POST /api/v1/auth/token`
- `GET /api/v1/user/profile`

Receipts:

- `POST /api/v1/receipt`
- `POST /api/v1/receipt/fiscal_data`
- `POST /api/v1/receipt/delete`

Other public bundle endpoints that are not required for this POC:

- `/api/v1/identifiers`
- `/api/v1/identifiers/receipt_expiration_date`
- `/api/v1/notification/list`
- `/api/v1/notification/count`
- `/api/v1/partner`
- `/api/v1/scan`

## Authentication flow

The frontend bundle uses a bearer token stored in browser storage.

Storage keys:

- `auth.token`
- `auth.token.expires`
- `refresh.token`
- `refresh.token.expires`
- `auth.token.store`

The client-side flow is:

1. Start phone challenge with `POST /api/v2/auth/challenge/phone/start`.
2. Verify SMS code with `POST /api/v1/auth/challenge/phone/verify`.
3. Save `token`, `refreshToken`, and expiry values.
4. Use `Authorization: Bearer <access-token>` on receipt/profile requests.
5. Refresh with `POST /api/v1/auth/token` when the access token is expired or the API returns an auth failure.

## Request payloads discovered in the bundle

### Start phone challenge

`POST /api/v2/auth/challenge/phone/start`

Body used by the frontend:

```json
{
  "phone": "...",
  "captchaToken": "...",
  "deviceInfo": {
    "sourceDeviceId": "...",
    "sourceType": "WEB",
    "appVersion": "1.0.0",
    "metaDetails": {
      "userAgent": "..."
    }
  }
}
```

### Verify phone challenge

`POST /api/v1/auth/challenge/phone/verify`

Body used by the frontend:

```json
{
  "challengeToken": "...",
  "phone": "...",
  "code": "...",
  "deviceInfo": { "...": "..." }
}
```

### Refresh

`POST /api/v1/auth/token`

Body used by the frontend:

```json
{
  "refreshToken": "...",
  "deviceInfo": { "...": "..." }
}
```

### List receipts

`POST /api/v1/receipt`

The frontend sends the filters as a JSON request body, not as query parameters.
The default frontend sort value is `CREATED_DATE:DESC`.

Query params from the frontend:

- `limit`
- `offset`
- `dateFrom`
- `dateTo`
- `orderBy`
- `inn`
- `kktOwner`

### Full receipt

`POST /api/v1/receipt/fiscal_data`

Body:

```json
{ "key": "receipt-key" }
```

## Observed receipt shapes

### Receipt list items

The UI reads:

- `key`
- `createdDate`
- `brand`
- `brandImage`
- `kktOwner`
- `kktOwnerInn`
- `totalSum`

### Full receipt

The receipt detail UI reads:

- `dateTime`
- `totalSum`
- `cashTotalSum`
- `ecashTotalSum`
- `prepaidSum`
- `userInn`
- `shiftNumber`
- `requestNumber`
- `machineNumber`
- `taxationType`
- `fiscalDocumentNumber`
- `fiscalDocumentFormatVer`
- `fiscalDriveNumber`
- `fiscalSign`
- `kktRegId`
- `operator`
- `retailPlace`
- `retailPlaceAddress`
- `operationType`
- `user`
- `items[]`
- `amountsReceiptNds`

Item fields used by the UI:

- `name`
- `price`
- `quantity`
- `sum`
- `providerInn`
- `nds`

## Known limitations and risks

- The service may change endpoints or payload shapes without notice.
- CAPTCHA and SMS verification are intentionally not bypassed.
- First login may require a manual browser step depending on the current FNS protections.
- Token refresh behavior is inferred from the frontend bundle and can change if the service changes its auth implementation.
- Some receipts may omit seller, INN, currency, or item-level fields. The normalizer keeps these fields nullable.
- The POC keeps tokens in a local JSON file inside `.receipt-collector/`. This is out of git, but it is not a hardware-backed secret store.

## Verification performed

- Confirmed the public login page and bundle assets from `lkdr.nalog.ru`.
- Confirmed the endpoint strings in the official frontend bundle.
- Confirmed the frontend uses bearer tokens and a refresh flow.
- Confirmed the receipt list and detail UI field names from the frontend bundle.
- Confirmed against the live service that the receipt list endpoint is `POST /api/v1/receipt`; an attempted `GET` returned `405 METHOD_NOT_ALLOWED`, then the corrected POST returned `200` with an empty list for the imported session.
