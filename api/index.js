// Vercel uses this REST entry point. MongoDB holds all state, so invite codes
// made by `npm run invite` are visible to this deployed function.
module.exports = require("../src/app").app;
