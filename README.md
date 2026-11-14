# 🚗 CarFlipCopilot — Симулятор Перекупа V2

Самостоятельная Telegram-игра про покупку, диагностику, ремонт и перепродажу автомобилей. Игра не подключается к оригинальному боту @m0dsbeamngbot и не изменяет его.

## Игровые системы
- Стартовый капитал: 3 000 000 ₽; гараж: 3 автомобиля.
- Авторынок с меняющимся спросом, конкуренцией и ограниченным временем лотов.
- Осмотр, диагностика, торг с продавцом, покупка и перепродажа.
- Гараж, ремонт, предпродажная подготовка и переговоры с покупателями.
- Детальная модель автомобиля: системы, узлы, детали, крепёж, совместимость, склад и рынок запчастей.
- Номерной рынок, контракты, опыт, уровни, репутация и статистика.
- Сохранение отдельного игрового профиля каждого Telegram-пользователя в PostgreSQL.
- Общий рейтинг игроков по игровому капиталу.

## Запуск
- Render service: `carflip-copilot-telegram`
- Start command: `npm run start:telegram`
- Required environment: `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`.
- Optional AI integrations are not required for core gameplay.

Never publish Telegram bot tokens, database connection strings, API hashes, or session strings.