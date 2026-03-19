const db = require('./database');

const agents = [
  { discord_id: '1186978205018632242', username: 'Team Leader', pin: '1234', role: 'admin' },
];


const insertAgent = db.prepare('INSERT OR REPLACE INTO agents (discord_id, username, pin, role) VALUES (?, ?, ?, ?)');

agents.forEach(agent => {
  insertAgent.run(agent.discord_id, agent.username, agent.pin, agent.role);
});

console.log('Database seeded with initial agents.');
