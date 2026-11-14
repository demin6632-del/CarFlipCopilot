const assert = require("node:assert/strict");
const { Pool } = require("pg");

if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.DATABASE_SSL = "false";

const game = require("./autonomous-game");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
});

async function run() {
  const suffix = String(Date.now());
  const battleChat = "economy-battle-" + suffix;
  const aiChat = "economy-ai-" + suffix;
  const send = async () => true;
  const answer = async () => true;

  try {
    await game.init();

    const battleInitial = await game.load(battleChat, "Battle Tester");
    const battleBalance = battleInitial.player.balance;
    const battleCallback = "battle-callback-" + suffix;

    await game.handleCallback(
      battleChat, "ag:battle_create", "Battle Tester", send, answer, battleCallback
    );
    let battleState = await game.load(battleChat, "Battle Tester");
    assert.equal(battleState.player.balance, battleBalance - 100000);
    assert.ok(battleState.processedCallbacks.includes(battleCallback));
    assert.equal(
      battleState.transactions.filter(x => x.kind === "container_battle_entry").length,
      1
    );

    // Simulate a retry after the original room has already closed.
    await pool.query(
      "UPDATE autonomous_container_battles SET status='finished',finished_at=now() WHERE owner_chat_id=$1 AND status='open'",
      [battleChat]
    );
    await game.handleCallback(
      battleChat, "ag:battle_create", "Battle Tester", send, answer, battleCallback
    );
    battleState = await game.load(battleChat, "Battle Tester");
    assert.equal(battleState.player.balance, battleBalance - 100000);
    assert.equal(
      battleState.transactions.filter(x => x.kind === "container_battle_entry").length,
      1
    );

    const aiInitial = await game.load(aiChat, "AI Tester");
    const car = { ...aiInitial.market[0], status: "owned" };
    aiInitial.market = aiInitial.market.filter(x => x.id !== car.id);
    aiInitial.garage.push(car);
    await game.save(aiChat, aiInitial);
    const aiBalance = aiInitial.player.balance;
    const aiCallback = "ai-duel-callback-" + suffix;

    await game.handleCallback(
      aiChat, "ag:duel_ai", "AI Tester", send, answer, aiCallback
    );
    let aiState = await game.load(aiChat, "AI Tester");
    assert.ok(aiState.processedCallbacks.includes(aiCallback));
    assert.equal(
      aiState.transactions.filter(x =>
        x.kind === "street_duel_entry" && x.description === "Взнос в дуэль с ИИ"
      ).length,
      1
    );
    const balanceAfterFirstDuel = aiState.player.balance;

    await game.handleCallback(
      aiChat, "ag:duel_ai", "AI Tester", send, answer, aiCallback
    );
    aiState = await game.load(aiChat, "AI Tester");
    assert.equal(aiState.player.balance, balanceAfterFirstDuel);
    assert.equal(
      aiState.transactions.filter(x =>
        x.kind === "street_duel_entry" && x.description === "Взнос в дуэль с ИИ"
      ).length,
      1
    );

    const duelCount = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM autonomous_street_duels WHERE challenger_chat_id=$1",
      [aiChat]
    );
    assert.equal(duelCount.rows[0].count, 1);
    assert.ok(balanceAfterFirstDuel <= aiBalance);

    console.log("Autonomous game economy idempotency integration: OK");
  } finally {
    await pool.query("DELETE FROM autonomous_game_state WHERE chat_id = ANY($1::text[])", [[battleChat, aiChat]]).catch(() => {});
    await pool.query("DELETE FROM autonomous_container_battles WHERE owner_chat_id=$1", [battleChat]).catch(() => {});
    await pool.query("DELETE FROM autonomous_street_duels WHERE challenger_chat_id=$1", [aiChat]).catch(() => {});
    await pool.end();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
