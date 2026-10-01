# DHL Express MyDHL fixtures (synthetic)

Hand-written, anonymised responses shaped like the MyDHL API **3.3.2** schema
(`src/server/integrations/generated/dhl-mydhl.ts`). There is no DHL account yet, so nothing here
was recorded from DHL: names are "Test …", addresses are placeholders, documents are tiny fake
PDFs, and `ZZ` is a deliberately unknown checkpoint code. Replace them with redacted recordings
once the painter's account exists (`npm run check:dhl`).

| File | Used for |
|---|---|
| `create-shipment-201.json` | `POST /shipments` success: waybill, label + commercial invoice (base64 PDF) |
| `create-shipment-no-label-201.json` | 201 without a label document (→ LABEL_UNKNOWN) |
| `error-400.json` / `error-500.json` | clear refusal / server error |
| `tracking-200.json` | all-checkpoints tracking, unsorted, mixed GMT offsets, one unknown code |
| `tracking-404.json` | not scanned yet |
| `pickup-201.json` | `POST /pickups` |
