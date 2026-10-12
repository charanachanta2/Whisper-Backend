# Vercel runtime fix

The previous `vercel.json` used `nodejs22.x` inside the `functions` runtime field.
That field expects a legacy Vercel builder/runtime identifier, so Vercel rejected it
with "Function Runtimes must have a valid version".

This fixed version removes the `functions` block entirely. Vercel automatically
detects `api/index.js` as a Node.js serverless function.

Deploy the contents of this backend folder as the Vercel project root.

Set:
- ADMIN_SESSION_SECRET
- INVITE_SECRET

Then test:
`https://YOUR-DOMAIN/health`
