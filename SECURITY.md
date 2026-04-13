# Security Policy

## Reporting a Vulnerability

I take the security of HDA Vault seriously. If you believe you have found a security vulnerability, please do NOT report it via public issues. 

Instead, please report it privately to the creator, Raj Mitra. You can reach out through the following channels:

- **GitHub Private Vulnerability Reporting:** Please use the "Report a vulnerability" button in the "Security" tab of this repository.

## My Commitment

If you report a vulnerability, I will:
- Acknowledge receipt of your report within 48 hours.
- Provide an estimated timeline for a fix.
- Notify you once the vulnerability is patched.

## Out of Scope

- Reverse-engineering the HDA Protocol for malicious use.
- Public disclosure of vulnerabilities before a patch is released.
- Intentional data corruption or theft.

## Secret Management

Developers contributing to this project must NEVER commit secrets, API keys, or `.env` files to the repository. Use local environment variables or GitHub Secrets for any sensitive configurations.
