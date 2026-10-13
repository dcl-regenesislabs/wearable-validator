# Deployment

The site is static: every check runs in the browser, so there is no backend to deploy.

- **Web**: wearable-validator.dclregenesislabs.xyz, served as static assets by Cloudflare Workers (`wrangler.jsonc`), behind Cloudflare Access, where curators sign in with their email.
- **Deploy**: every push to `main` redeploys it through Workers Builds. Workers & Pages → `wearable-validator` → Settings → Build: build command `npm ci && npm run build -w wearable-validator-web`, deploy command `npx wrangler deploy`.
- **Access**: Zero Trust → Access → Applications → Self-hosted, domain `wearable-validator.dclregenesislabs.xyz`, a policy that allows the curators' emails.

The visual checks (renders and the model's review) are not run here. They run in the validation job of decentraland/wearable-validator.

## Local development

```sh
npm run dev   # the site at http://localhost:5173
```
