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
  const streetChat = "economy-street-" + suffix;
  const ledgerChat = "economy-ledger-" + suffix;
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
    let ledgerRows = await pool.query(
      "SELECT kind,amount FROM autonomous_economy_ledger WHERE chat_id=$1",
      [battleChat]
    );
    assert.equal(ledgerRows.rowCount, 1);
    assert.equal(ledgerRows.rows[0].kind, "container_battle_entry");
    assert.equal(Number(ledgerRows.rows[0].amount), -100000);

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
    ledgerRows = await pool.query(
      "SELECT transaction_id FROM autonomous_economy_ledger WHERE chat_id=$1",
      [battleChat]
    );
    assert.equal(ledgerRows.rowCount, 1);

    const streetInitial = await game.load(streetChat, "Street Tester");
    const streetCar = { ...streetInitial.market[0], status: "owned" };
    streetInitial.market = streetInitial.market.filter(x => x.id !== streetCar.id);
    streetInitial.garage.push(streetCar);
    await game.save(streetChat, streetInitial);
    const streetBalance = streetInitial.player.balance;
    const streetCallback = "street-duel-callback-" + suffix;

    await game.handleCallback(
      streetChat, "ag:duel_create:" + streetCar.id, "Street Tester", send, answer, streetCallback
    );
    let streetState = await game.load(streetChat, "Street Tester");
    assert.ok(streetState.processedCallbacks.includes(streetCallback));
    assert.equal(streetState.player.balance, streetBalance - 50000);
    assert.equal(
      streetState.transactions.filter(x =>
        x.kind === "street_duel_entry" && x.description.startsWith("Взнос в уличную дуэль №")
      ).length,
      1
    );

    // Simulate a completed challenge before Telegram retries the same callback.
    await pool.query(
      "UPDATE autonomous_street_duels SET status='finished',finished_at=now() WHERE challenger_chat_id=$1 AND status='open'",
      [streetChat]
    );
    await game.handleCallback(
      streetChat, "ag:duel_create:" + streetCar.id, "Street Tester", send, answer, streetCallback
    );
    streetState = await game.load(streetChat, "Street Tester");
    assert.equal(streetState.player.balance, streetBalance - 50000);
    assert.equal(
      streetState.transactions.filter(x =>
        x.kind === "street_duel_entry" && x.description.startsWith("Взнос в уличную дуэль №")
      ).length,
      1
    );
    const streetDuelCount = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM autonomous_street_duels WHERE challenger_chat_id=$1",
      [streetChat]
    );
    assert.equal(streetDuelCount.rows[0].count, 1);
    ledgerRows = await pool.query(
      "SELECT kind,amount FROM autonomous_economy_ledger WHERE chat_id=$1",
      [streetChat]
    );
    assert.equal(ledgerRows.rowCount, 1);
    assert.equal(ledgerRows.rows[0].kind, "street_duel_entry");
    assert.equal(Number(ledgerRows.rows[0].amount), -50000);

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
    assert.ok([aiBalance - 50000, aiBalance, aiBalance + 45000].includes(balanceAfterFirstDuel));
    ledgerRows = await pool.query(
      "SELECT kind,amount FROM autonomous_economy_ledger WHERE chat_id=$1",
      [aiChat]
    );
    assert.equal(
      ledgerRows.rowCount,
      aiState.transactions.filter(x =>
        x.kind === "street_duel_entry" || x.kind === "street_duel_refund" || x.kind === "street_duel_prize"
      ).length
    );

    const legacyState = await game.load(ledgerChat, "Ledger Tester");
    legacyState.transactions = [{
      time: Date.now(), kind: "legacy_backfill_test", amount: -123,
      balance: legacyState.player.balance - 123, description: "Legacy ledger backfill test"
    }];
    legacyState.player.balance -= 123;
    await game.save(ledgerChat, legacyState);
    let backfill = await pool.query(
      "SELECT transaction_id,kind,amount FROM autonomous_economy_ledger WHERE chat_id=$1",
      [ledgerChat]
    );
    assert.equal(backfill.rowCount, 1);
    assert.equal(backfill.rows[0].kind, "legacy_backfill_test");
    assert.equal(Number(backfill.rows[0].amount), -123);
    assert.ok(legacyState.transactions[0].id);
    await game.save(ledgerChat, legacyState);
    backfill = await pool.query(
      "SELECT transaction_id FROM autonomous_economy_ledger WHERE chat_id=$1",
      [ledgerChat]
    );
    assert.equal(backfill.rowCount, 1);

    console.log("Autonomous game economy idempotency and ledger integration: OK");
  } finally {
    await pool.query("DELETE FROM autonomous_economy_ledger WHERE chat_id = ANY($1::text[])", [[battleChat, aiChat, streetChat, ledgerChat]]).catch(() => {});
    await pool.query("DELETE FROM autonomous_game_state WHERE chat_id = ANY($1::text[])", [[battleChat, aiChat, streetChat, ledgerChat]]).catch(() => {});
    await pool.query("DELETE FROM autonomous_container_battles WHERE owner_chat_id=$1", [battleChat]).catch(() => {});
    await pool.query("DELETE FROM autonomous_street_duels WHERE challenger_chat_id = ANY($1::text[])", [[aiChat, streetChat]]).catch(() => {});
    await pool.end();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
