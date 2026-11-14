# 🚗 CarFlipCopilot — самостоятельный Telegram-симулятор перекупа

Проект включает Android-компаньон CarFlipCopilot и отдельную игровую Telegram-игру AUTOFLIP. Игровой бот не подключается к @m0dsbeamngbot и не изменяет его.

## Игровые механики
- Рынок подержанных автомобилей, осмотр, диагностика, торг, покупка и продажа.
- Гараж, ремонт, предпродажная подготовка, детальная система узлов и запчастей.
- Номерной рынок и торги, контракты, опыт, уровни, репутация и статистика.
- Банк: кредиты с комиссией, сроком и досрочным погашением.
- Корректировка одометра с повышением потенциальной цены и риском проверки истории.
- Сохранение профиля каждого игрока в PostgreSQL и общий рейтинг игроков.

## Запуск Telegram-игры
- Render service: `carflip-copilot-telegram`
- Start command: `npm run start:telegram`
- Required environment: `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`.
- Optional AI integrations are not required for core gameplay.

## Безопасность
Never publish Telegram bot tokens, database connection strings, API hashes, or session strings.
