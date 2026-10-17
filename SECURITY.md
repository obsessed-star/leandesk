# Security

This release is a single-node pilot. Store credentials in local environment configuration or a secret manager. Never commit `.env`, SQLite, real employee identifiers or customer documents. Rotate credentials shared in chat or previously committed. Public webhooks require HTTPS; protect persistent storage and backups.

Telegram verifies its webhook secret. The WhatsApp Chat SDK adapter verifies Meta signatures and the setup challenge. Transport authentication is separate from tenant/scope authorization through server identity bindings. Leave unused channel credentials unset.

Documents and messages are untrusted evidence. No shell or arbitrary execution tool is exposed. Source-ID checks and prompt rules reduce risk but do not prove semantic correctness or eliminate prompt injection. Review knowledge content and escalate sensitive operations to humans.

Redaction covers common emails and credential patterns; it is best effort, not complete DLP. Never submit recovery codes, passwords or confidential records to an unapproved provider. Stored answers and drafts may contain business data. Physical retention/purge and encryption at rest remain deployment responsibilities.

## Dependencies

The lockfile pins the tested graph. Overrides select patched `undici` and `guarded-fetch` versions. A remaining **moderate** `sprintf-js` denial-of-service advisory ([GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)) had no fixed release at the recorded audit, through eve / just-bash / @vercel/connect paths.

Support routes expose no shell or user-controlled format-string execution; the default eve session route is disabled. This limits exposure but does not remove the transitive package. Run `npm audit` before deployment and reassess when adding capabilities. CI blocks high/critical findings; moderate findings stay visible rather than forcing an incompatible framework downgrade.

## Reporting

Keep secrets and private employee data out of public issues. Give the repository owner non-sensitive reproduction steps and coordinate confidential details privately. No response-time guarantee or security certification is implied.
