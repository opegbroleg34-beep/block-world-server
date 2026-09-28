# Block World multiplayer server — PvP + mobs

Node.js HTTP server for the Block World browser game.

Features:
- rooms and room browser;
- multiplayer synchronization;
- chat;
- shared blocks, doors, chests and drops;
- PvP with fists / wooden sword / stone sword;
- server-authoritative player damage;
- synchronized mobs;
- hostile mobs: zombie, skeleton, spider;
- peaceful mobs: cow, sheep, pig.

## Render
Build command:

npm install

Start command:

npm start

Health check:

/health

## Important update
When upgrading an existing server, replace both `server.js` and `game-rules.js`, then commit them to GitHub. Render should redeploy automatically.
