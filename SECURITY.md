# Security Policy

## Reporting a Vulnerability

To report a security issue, please open either:

- a GitHub Issue, or
- a GitHub Pull Request

Include clear reproduction steps, impact details, and any suggested mitigation.

## Support Policy

Security patches are tracked and fixed only on the `main` branch.

Previous releases are not patched.

## Getting Security Updates

For the fastest security updates, run the Docker image tracking `:latest` and
keep it updated regularly.

Example update flow:

```bash
docker compose pull
docker compose up -d
```
