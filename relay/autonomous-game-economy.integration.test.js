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
  const battleGuestChat = "economy-battle-guest-" + suffix;
  const aiChat = "economy-ai-" + suffix;
  const streetChat = "economy-street-" + suffix;
  const cancelChat = "economy-cancel-" + suffix;
  const challengeChat = "economy-challenger-" + suffix;
  const opponentChat = "economy-opponent-" + suffix;
  const ledgerChat = "economy-ledger-" + suffix;
  const genericChat = "economy-generic-" + suffix;
  const buyChat = "economy-buy-" + suffix;
  const send = async () => true;
  const answer = async () => true;

  try {
    await game.init();
    await game.init(); // schema and append-only trigger creation must be idempotent

    // A repeated purchase callback must transfer the car and debit the buyer only once.
    let ledgerRows;
    const buyInitial = await game.load(buyChat, "Vehicle Buyer");
    const buyCandidate = buyInitial.market
      .filter(car => Number(car.buyPrice) <= Number(buyInitial.player.balance))
      .sort((a, b) => Number(a.buyPrice) - Number(b.buyPrice))[0];
    assert.ok(buyCandidate, "test profile must have at least one affordable vehicle listing");
    const buyInitialBalance = buyInitial.player.balance;
    const buyCallback = "vehicle-buy-" + suffix;
    await Promise.all([
      game.handleCallback(
        buyChat, "ag:buy:" + buyCandidate.id, "Vehicle Buyer", send, answer, buyCallback
      ),
      game.handleCallback(
        buyChat, "ag:buy:" + buyCandidate.id, "Vehicle Buyer", send, answer, buyCallback
      )
    ]);
    const boughtState = await game.load(buyChat, "Vehicle Buyer");
    assert.equal(boughtState.player.balance, buyInitialBalance - buyCandidate.buyPrice);
    assert.equal(boughtState.garage.filter(car => String(car.id) === String(buyCandidate.id)).length, 1);
    assert.equal(boughtState.transactions.filter(tx => tx.kind === "buy").length, 1);
    ledgerRows = await pool.query(
      "SELECT kind,amount FROM autonomous_economy_ledger WHERE chat_id=$1",
      [buyChat]
    );
    assert.equal(ledgerRows.rowCount, 1);
    assert.equal(ledgerRows.rows[0].kind, "buy");
    assert.equal(Number(ledgerRows.rows[0].amount), -Number(buyCandidate.buyPrice));

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
    ledgerRows = await pool.query(
      "SELECT kind,amount FROM autonomous_economy_ledger WHERE chat_id=$1",
      [battleChat]
    );
    assert.equal(ledgerRows.rowCount, 1);
    assert.equal(ledgerRows.rows[0].kind, "container_battle_entry");
    assert.equal(Number(ledgerRows.rows[0].amount), -100000);

    const openBattle = await pool.query(
      "SELECT id FROM autonomous_container_battles WHERE owner_chat_id=$1 AND status='open'",
      [battleChat]
    );
    assert.equal(openBattle.rowCount, 1);
    const battleGuestInitial = await game.load(battleGuestChat, "Battle Guest");
    const battleGuestBalance = battleGuestInitial.player.balance;
    await game.handleCallback(
      battleGuestChat, "ag:battle_join:" + openBattle.rows[0].id, "Battle Guest", send, answer,
      "battle-join-" + suffix
    );
    let battleGuestState = await game.load(battleGuestChat, "Battle Guest");
    assert.equal(battleGuestState.player.balance, battleGuestBalance - 100000);
    ledgerRows = await pool.query(
      "SELECT transaction_id FROM autonomous_economy_ledger WHERE chat_id=$1",
      [battleGuestChat]
    );
    assert.equal(ledgerRows.rowCount, 1);

    await game.handleCallback(
      battleChat, "ag:battle_start:" + openBattle.rows[0].id, "Battle Tester", send, answer,
      "battle-start-" + suffix
    );
    battleState = await game.load(battleChat, "Battle Tester");
    battleGuestState = await game.load(battleGuestChat, "Battle Guest");
    const battleResult = await pool.query(
      "SELECT results FROM autonomous_container_battles WHERE id=$1",
      [openBattle.rows[0].id]
    );
    assert.equal(battleResult.rowCount, 1);
    const ownerReward = battleResult.rows[0].results.find(x => String(x.chatId) === battleChat)?.reward || 0;
    const guestReward = battleResult.rows[0].results.find(x => String(x.chatId) === battleGuestChat)?.reward || 0;
    assert.equal(battleState.player.balance, battleBalance - 100000 + ownerReward);
    assert.equal(battleGuestState.player.balance, battleGuestBalance - 100000 + guestReward);
    for (const [chatId, state] of [[battleChat, battleState], [battleGuestChat, battleGuestState]]) {
      const rows = await pool.query(
        "SELECT transaction_id FROM autonomous_economy_ledger WHERE chat_id=$1",
        [chatId]
      );
      assert.equal(
        rows.rowCount,
        state.transactions.filter(x =>
          x.kind === "container_battle_entry" || x.kind === "container_battle_prize"
        ).length
      );
    }

    // Replaying the original create callback after the room has finished must not charge again.
    await game.handleCallback(
      battleChat, "ag:battle_create", "Battle Tester", send, answer, battleCallback
    );
    battleState = await game.load(battleChat, "Battle Tester");
    assert.equal(battleState.player.balance, battleBalance - 100000 + ownerReward);
    const battleCount = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM autonomous_container_battles WHERE owner_chat_id=$1",
      [battleChat]
    );
    assert.equal(battleCount.rows[0].count, 1);

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

    const cancelInitial = await game.load(cancelChat, "Cancel Tester");
    const cancelCar = { ...cancelInitial.market[0], status: "owned" };
    cancelInitial.market = cancelInitial.market.filter(x => x.id !== cancelCar.id);
    cancelInitial.garage.push(cancelCar);
    await game.save(cancelChat, cancelInitial);
    const cancelBalance = cancelInitial.player.balance;
    await game.handleCallback(
      cancelChat, "ag:duel_create:" + cancelCar.id, "Cancel Tester", send, answer,
      "cancel-create-" + suffix
    );
    const cancelDuel = await pool.query(
      "SELECT id FROM autonomous_street_duels WHERE challenger_chat_id=$1 AND status='open'",
      [cancelChat]
    );
    assert.equal(cancelDuel.rowCount, 1);
    const cancelCallback = "cancel-duel-" + suffix;
    await game.handleCallback(
      cancelChat, "ag:duel_cancel:" + cancelDuel.rows[0].id, "Cancel Tester", send, answer,
      cancelCallback
    );
    let cancelState = await game.load(cancelChat, "Cancel Tester");
    assert.equal(cancelState.player.balance, cancelBalance);
    let cancelLedger = await pool.query(
      "SELECT kind,amount FROM autonomous_economy_ledger WHERE chat_id=$1 ORDER BY occurred_at",
      [cancelChat]
    );
    assert.equal(cancelLedger.rowCount, 2);
    assert.deepEqual(cancelLedger.rows.map(x => x.kind).sort(), ["street_duel_entry", "street_duel_refund"]);
    await game.handleCallback(
      cancelChat, "ag:duel_cancel:" + cancelDuel.rows[0].id, "Cancel Tester", send, answer,
      cancelCallback
    );
    cancelState = await game.load(cancelChat, "Cancel Tester");
    assert.equal(cancelState.player.balance, cancelBalance);
    cancelLedger = await pool.query(
      "SELECT transaction_id FROM autonomous_economy_ledger WHERE chat_id=$1",
      [cancelChat]
    );
    assert.equal(cancelLedger.rowCount, 2);

    const challengerInitial = await game.load(challengeChat, "Challenger");
    const challengerCar = { ...challengerInitial.market[0], status: "owned" };
    challengerInitial.market = challengerInitial.market.filter(x => x.id !== challengerCar.id);
    challengerInitial.garage.push(challengerCar);
    await game.save(challengeChat, challengerInitial);
    const opponentInitial = await game.load(opponentChat, "Opponent");
    const opponentCar = { ...opponentInitial.market[0], status: "owned" };
    opponentInitial.market = opponentInitial.market.filter(x => x.id !== opponentCar.id);
    opponentInitial.garage.push(opponentCar);
    await game.save(opponentChat, opponentInitial);
    const challengerBalance = challengerInitial.player.balance;
    const opponentBalance = opponentInitial.player.balance;
    await game.handleCallback(
      challengeChat, "ag:duel_create:" + challengerCar.id, "Challenger", send, answer,
      "challenge-create-" + suffix
    );
    const openStreet = await pool.query(
      "SELECT id FROM autonomous_street_duels WHERE challenger_chat_id=$1 AND status='open'",
      [challengeChat]
    );
    assert.equal(openStreet.rowCount, 1);
    await game.handleCallback(
      opponentChat, "ag:duel_join:" + openStreet.rows[0].id, "Opponent", send, answer,
      "challenge-join-" + suffix
    );
    const settled = await pool.query(
      "SELECT status,result FROM autonomous_street_duels WHERE id=$1",
      [openStreet.rows[0].id]
    );
    assert.equal(settled.rows[0].status, "finished");
    const result = settled.rows[0].result;
    const expectedChallenger = result.draw ? challengerBalance :
      String(result.winnerChat) === challengeChat ? challengerBalance + 45000 : challengerBalance - 50000;
    const expectedOpponent = result.draw ? opponentBalance :
      String(result.winnerChat) === opponentChat ? opponentBalance + 45000 : opponentBalance - 50000;
    const challengerState = await game.load(challengeChat, "Challenger");
    const opponentState = await game.load(opponentChat, "Opponent");
    assert.equal(challengerState.player.balance, expectedChallenger);
    assert.equal(opponentState.player.balance, expectedOpponent);
    for (const [chatId, state] of [[challengeChat, challengerState], [opponentChat, opponentState]]) {
      const rows = await pool.query(
        "SELECT transaction_id FROM autonomous_economy_ledger WHERE chat_id=$1",
        [chatId]
      );
      assert.equal(
        rows.rowCount,
        state.transactions.filter(x =>
          x.kind === "street_duel_entry" || x.kind === "street_duel_refund" || x.kind === "street_duel_prize"
        ).length
      );
    }

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

    // Two concurrent deliveries of the same callback must produce exactly one duel and one stake.
    const aiRaceCallback = "ai-duel-race-" + suffix;
    await Promise.all([
      game.handleCallback(aiChat, "ag:duel_ai", "AI Tester", send, answer, aiRaceCallback),
      game.handleCallback(aiChat, "ag:duel_ai", "AI Tester", send, answer, aiRaceCallback)
    ]);
    aiState = await game.load(aiChat, "AI Tester");
    assert.equal(
      aiState.transactions.filter(x =>
        x.kind === "street_duel_entry" && x.description === "Взнос в дуэль с ИИ"
      ).length,
      2
    );
    const balanceAfterRace = aiState.player.balance;
    const raceDuelCount = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM autonomous_street_duels WHERE challenger_chat_id=$1",
      [aiChat]
    );
    assert.equal(raceDuelCount.rows[0].count, 2);
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
    assert.ok([balanceAfterFirstDuel - 50000, balanceAfterFirstDuel, balanceAfterFirstDuel + 45000].includes(balanceAfterRace));

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

    // Generic state-mutating economy callbacks must also be idempotent under concurrent delivery.
    const genericInitial = await game.load(genericChat, "Generic Callback Tester");
    const genericBalance = genericInitial.player.balance;
    const genericCallback = "generic-crate-" + suffix;
    await Promise.all([
      game.handleCallback(
        genericChat, "ag:crate_open:standard", "Generic Callback Tester", send, answer, genericCallback
      ),
      game.handleCallback(
        genericChat, "ag:crate_open:standard", "Generic Callback Tester", send, answer, genericCallback
      )
    ]);
    const genericState = await game.load(genericChat, "Generic Callback Tester");
    assert.equal(
      genericState.transactions.filter(x => x.kind === "container_open").length,
      1
    );
    assert.equal(genericState.player.balance, genericBalance + genericState.transactions
      .filter(x => x.kind === "container_open" || x.kind === "container_cash" || x.kind === "container_jackpot")
      .reduce((sum, tx) => sum + Number(tx.amount || 0), 0));
    assert.ok(genericState.processedCallbacks.includes(genericCallback));

    // Distinct concurrent purchases for one player must both commit without losing a balance update.
    const genericSecondCallback = "generic-crate-second-" + suffix;
    const genericThirdCallback = "generic-crate-third-" + suffix;
    await Promise.all([
      game.handleCallback(
        genericChat, "ag:crate_open:standard", "Generic Callback Tester", send, answer, genericSecondCallback
      ),
      game.handleCallback(
        genericChat, "ag:crate_open:standard", "Generic Callback Tester", send, answer, genericThirdCallback
      )
    ]);
    const afterDistinctCallbacks = await game.load(genericChat, "Generic Callback Tester");
    const crateDebitTransactions = afterDistinctCallbacks.transactions.filter(
      x => x.kind === "container_open"
    );
    assert.equal(crateDebitTransactions.length, 3);
    assert.equal(crateDebitTransactions.filter(x => Number(x.amount) === -150000).length, 3);
    assert.equal(
      afterDistinctCallbacks.player.balance,
      genericBalance + afterDistinctCallbacks.transactions
        .filter(x => ["container_open", "container_cash", "container_jackpot"].includes(x.kind))
        .reduce((sum, tx) => sum + Number(tx.amount || 0), 0)
    );

    // The durable callback receipt must still reject a replay after the legacy 100-ID window rolls over.
    const firstRefreshCallback = "generic-refresh-first-" + suffix;
    await game.handleCallback(
      genericChat, "ag:refresh", "Generic Callback Tester", send, answer, firstRefreshCallback
    );
    for (let i = 0; i < 105; i++) {
      await game.handleCallback(
        genericChat, "ag:refresh", "Generic Callback Tester", send, answer,
        "generic-refresh-" + i + "-" + suffix
      );
    }
    const beforeOldReplay = await game.load(genericChat, "Generic Callback Tester");
    const turnBeforeOldReplay = beforeOldReplay.meta.turn;
    assert.equal(beforeOldReplay.processedCallbacks.includes(firstRefreshCallback), false);
    await game.handleCallback(
      genericChat, "ag:refresh", "Generic Callback Tester", send, answer, firstRefreshCallback
    );
    const afterOldReplay = await game.load(genericChat, "Generic Callback Tester");
    assert.equal(afterOldReplay.meta.turn, turnBeforeOldReplay);
    const durableReceipt = await pool.query(
      "SELECT callback_id FROM autonomous_processed_callbacks WHERE chat_id=$1 AND callback_id=$2",
      [genericChat, firstRefreshCallback]
    );
    assert.equal(durableReceipt.rowCount, 1);
    ledgerRows = await pool.query(
      "SELECT transaction_id FROM autonomous_economy_ledger WHERE chat_id=$1",
      [genericChat]
    );
    assert.equal(
      ledgerRows.rowCount,
      afterDistinctCallbacks.transactions.filter(x => x.kind === "container_open" || x.kind === "container_cash" || x.kind === "container_jackpot").length
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
    await assert.rejects(
      pool.query("UPDATE autonomous_economy_ledger SET amount=0 WHERE chat_id=$1", [ledgerChat]),
      /append-only/
    );
    await assert.rejects(
      pool.query("DELETE FROM autonomous_economy_ledger WHERE chat_id=$1", [ledgerChat]),
      /append-only/
    );

    console.log("Autonomous game economy idempotency and ledger integration: OK");
  } finally {
    await pool.query("DELETE FROM autonomous_economy_ledger WHERE chat_id = ANY($1::text[])", [[battleChat, battleGuestChat, aiChat, streetChat, cancelChat, challengeChat, opponentChat, ledgerChat, genericChat, buyChat]]).catch(() => {});
    await pool.query("DELETE FROM autonomous_processed_callbacks WHERE chat_id = ANY($1::text[])", [[battleChat, battleGuestChat, aiChat, streetChat, cancelChat, challengeChat, opponentChat, ledgerChat, genericChat, buyChat]]).catch(() => {});
    await pool.query("DELETE FROM autonomous_game_state WHERE chat_id = ANY($1::text[])", [[battleChat, aiChat, streetChat, ledgerChat, genericChat, buyChat]]).catch(() => {});
    await pool.query("DELETE FROM autonomous_container_battles WHERE owner_chat_id=$1", [battleChat]).catch(() => {});
    await pool.query("DELETE FROM autonomous_street_duels WHERE challenger_chat_id = ANY($1::text[])", [[aiChat, streetChat, cancelChat, challengeChat]]).catch(() => {});
    await pool.end();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
