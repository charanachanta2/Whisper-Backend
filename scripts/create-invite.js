// Generate an invitation code for the private app.
// Usage: node scripts/create-invite.js [days-valid]
// The generated code can be given to exactly one new user.
const crypto = require("crypto");
const { loadState, saveState } = require("../src/store");

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
  console.log(`Invitation code: ${code}`);
  console.log(`Valid for ${days} day(s).`);
}

main().catch(error => {
  console.error(`Could not create invitation: ${error.message}`);
  process.exitCode = 1;
});
