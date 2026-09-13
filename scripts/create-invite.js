// Generate an invitation code for the private app.
// Usage: node scripts/create-invite.js [days-valid]
// The generated code can be given to exactly one new user.
const crypto = require("crypto");
const { loadState, saveState, flush } = require("../src/store");

const SECRET = process.env.INVITE_SECRET || "change-me-invite-secret";
const days = Number(process.argv[2] || 30);
const code = crypto.randomBytes(6).toString("hex").toUpperCase();
const hash = crypto.createHmac("sha256", SECRET).update(code).digest("hex");

async function main() {
  const db = await loadState();
  db.invites.push({
    hash,
    used: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + days * 86400000,
  });
  await saveState(db);
  // saveState() now debounces its Mongo write (see store.js) so the running
  // server can coalesce bursts of activity into fewer writes. That's the
  // wrong behavior for this one-off script, which exits right after --
  // without an explicit flush, the process could exit before the debounced
  // write ever reaches Mongo, printing a code that was never actually saved.
  await flush();
  console.log(`Invitation code: ${code}`);
  console.log(`Valid for ${days} day(s).`);
}

main().catch(error => {
  console.error(`Could not create invitation: ${error.message}`);
  process.exitCode = 1;
});
