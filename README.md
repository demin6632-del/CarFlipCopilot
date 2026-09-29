# 🚗 CarFlipCopilot

Android companion for «Симулятор Перекупа 💸».

## Текущая цель
CarFlipCopilot анализирует всю игровую ситуацию в реальном времени и показывает одно понятное действие: **что сделать прямо сейчас и почему это выгодно**.

## Уже реализовано
- MediaProjection: явный захват экрана после подтверждения Android.
- Локальный OCR через Google ML Kit.
- Плавающая панель поверх Telegram.
- Распознавание цены, мощности, состояния и игровых событий.
- Анализ новостей и промокодов.
- Анализ аукционов и номерных знаков.
- Сравнение продажи автомобиля с ремонтом и улучшениями по ожидаемому финансовому результату.
- Память фактических результатов для последующей корректировки прогнозов.
- Защита OCR от накопления очереди кадров.
- Приложение не нажимает кнопки Telegram автоматически.

## Сборка
CI rebuild check.


## Telegram-only game bridge

The Telegram version uses a server-side MTProto user session to communicate with `@m0dsbeamngbot`. The CarFlipCopilot bot remains the user interface.

Required server secrets:
- `TELEGRAM_BOT_TOKEN` — token of the CarFlipCopilot bot from @BotFather.
- `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` — Telegram API credentials for the user session.
- `RELAY_URL` and `COPILOT_TOKEN` — relay connection.
- `OPENAI_API_KEY` — optional for AI analysis/advice.
- `BRIDGE_PUBLIC_URL` — public HTTPS URL of the Telegram bridge service.
- `GAME_BOT_USERNAME=m0dsbeamngbot`.

After deployment:
1. Open the CarFlipCopilot bot in Telegram.
2. Press **🔗 Подключить игру**.
3. Open **🎮 Подключить игру**.
4. Complete Telegram QR authorization in the official Telegram client.
5. Return to CarFlipCopilot and use **/bridge**, **📊 Состояние**, and **🧠 Что делать сейчас**.

Never send Telegram login codes, 2FA passwords, bot tokens, API hashes, or session strings through the chat.
