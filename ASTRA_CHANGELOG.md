# Astra — отчёт об изменениях, 2026-09-16

**Статус:** исправления подготовлены и проверены локально. Код ещё не опубликован и сервис Astra ещё не развёрнут: GitHub отклонил создание README в `hobbit7771/-` с `403 Resource not accessible by integration`. Подключению нужен доступ к содержимому нового репозитория. Render дополнительно требует подтверждения пространства **My Workspace**; сервис в неподтверждённом пространстве не создавался. Исходный удалённый проект Claude не изменён.

## Что было неправильно и что исправлено

Карта исходной реализации составлена до изменений: [CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md). Основа — commit `03182b433eebe3444a49ca7d967e7090c936a2af`, ветка `claude/t3-elliott-wave-engine-gw2gm1`.

1. **ENGINE OFF на скриншоте.** В конфигурации развёртывания не было `LEAD_ENGINE_ENABLED=true`. В отдельном Astra Blueprint флаг включён, точка входа — `astra_app:app`. Отключённый движок и включённый движок без качественных данных остаются разными состояниями. Старый сервис на скриншоте не перенастраивался.
2. **Стакан.** Удалено неверное требование `u == previous_u + 1`: допускаются возрастающие непоследовательные ID. При потере транспорта/очереди нужен новый snapshot. Проверяются NaN/Infinity, отрицательные размеры, пустой/crossed book. Snapshot/reset сбрасывает кэш сортировки. Потерянные дельты не маскируются.
3. **Нормализация.** Основной delta — ограниченный `(buy-sell)/(buy+sell)` с защитой от нуля и переполнения. Raw ratio не используется как основной pressure feature. У CVD и microprice сохранён физический знак: mean-centred z-score больше не превращает слабое положительное значение в bearish. Derivatives масштабируются по rolling reference. Повторные чтения одного кадра не добавляют повторные samples нормализатора.
4. **Book/absorption/walls.** Сохранены раздельные top/deep/consistency/alignment. Microprice масштабируется через spread с учётом глубины. Новая transient wall не получает полный вес за счёт сокращения коэффициента в дроби. Уточнены replenishment, cancellation, distance и классификация стен. Absorption ограничен подтверждаемым сочетанием исполнений и добавления объёма; выводятся volume/depth/z-score/percentile и bounded scores. L2 не даёт идентичность каждой заявки: pulling/absorption/spoof остаются оценками.
5. **Структура.** Устранено изменение BOS/CHoCH при повторном чтении без новой закрытой свечи. Elliott-контекст не увеличивает reset-счётчики на чтении и опирается на последние завершённые участки. Структура использует закрытые свечи; будущие pivots не переносят старые сигналы.
6. **Пять слоёв.** Flow, Book, Structure, Derivatives, BTC Lead агрегируются существующим модульным механизмом с конфигурируемыми весами 30/25/20/15/10. Усилен учёт независимого покрытия данных и конфликтов; высокий конфликт/недостаточная confidence блокируют сильные состояния, включая reversal. Один OBI1 не достаточен для сильного сигнала. Веса не объявлены оптимальными.
7. **Derivatives/BTC.** Исправлен знак Bybit `allLiquidation.S`: Buy — ликвидированная long-позиция, Sell — short. Доходности через пропуски секунд не считаются односекундными. BTC-контекст защищён от параллельных изменений и берётся из свежего рассчитанного кадра. Отсутствующие OI/BTC данные снижают покрытие.
8. **PRE-BREAK.** Зеркальная логика support ниже цены / resistance выше цены; отдельно видны 13 признаков, включая depth drain, pulling, replenishment, CVD, acceleration, microprice, deep OBI, BTC, ликвидации. Кэш закрытых баров исключает повторные тяжёлые перестроения при чтении.
9. **Score и probability.** Интерфейс показывает MODEL SCORE. История сигнала хранит первоначальные время/цену. Переключение направления или уровня создаёт новое событие. Calibration исключает пересекающиеся случаи и наблюдения через разрывы потока; неполный будущий горизонт не считается провалом. Реальная out-of-sample валидация probability ещё не проведена; точность модели и прибыльность не подтверждены.
10. **Потоки/здоровье.** Вычисления работают по собственному таймеру даже без открытого браузера. При reconnect сбрасывается синхронизация. Очередь ограничена, старые epochs отбрасываются. BOOK_AGE/TRADE_AGE основаны на exchange time; отдельно доступны arrival age, задержка очереди, обработки, UI, reconnects и drops. Пропавшие trades, stale book, resync, disconnect, backlog, усечённое rolling window отключают сигналы.
11. **Trade flow и replay.** Дедупликация trade ID, отбрасывание старых trades, правильное старение окон в тишине. Replay сохраняет порядок поступления, конфиг и реальную свежесть; отсутствующие потоки больше не объявляются свежими. Recorder сохраняет все новые переходы между своими тактами; HTTP-чтения не создают лишние записи.
12. **Стабильность UI.** Сохранён plain JavaScript; React/Vue не добавлялись. DOM блоков создаётся один раз; обновляются изменившиеся значения. Один pending frame заменяется последним. HTTP-запросы не накапливаются; устаревшие ответы после переключения монеты игнорируются. Исправлено обновление header. Tabular numbers, фиксированная ширина, deadband цветов; обработчики/таймеры/сокеты освобождаются.
13. **График.** Существующий Lightweight Charts 4.1.3 подключён к настоящему Bybit kline WS. Удалено изобретение свечей из HTTP-price и браузерных часов. История REST загружается при выборе/восстановлении, текущие OHLC/volume/confirm поступают через incremental update. Zoom/pan/crosshair/volume/dark mode сохранены. Есть 1m/3m/5m/15m/30m/1H/4H/1D, полноэкранный и мобильный режим. Буфер свечей ограничен 1500; редкая перебазировка ограничивает внутреннюю память графика.
14. **EMA/Fib/events.** EMA 9/18/50/200 обновляются от предыдущей завершённой EMA, без многократного накопления текущей live candle; инициализация — SMA первых period закрытий. Переключатели сохраняются. Fib больше не затирается пустым состоянием при первом открытии; отдельные symbol/TF, направление, retracement/extensions, hide/delete/reset, ограничение 20 рисунков, touch без принятия drag/pinch за точку. Event overlay использует исходные время и цену и долю времени внутри свечи; сигнал не сдвигается на позднее найденный pivot.
15. **PAPER P&L.** Новый изолированный журнал: причинный вход по следующему свежему стакану, fills по глубине, две комиссии, проскальзывание, stop/target/timeout, одна позиция на монету, дедупликация сигнала, капитал и итоги. SQLite writer отделён от расчётов и ограничен очередью; ошибка хранения останавливает новые paper-входы. Восстановление после рестарта с тем же файлом; пропуски данных отмечаются GAP. Отдельная страница `/paper`, открытый/закрытый P&L и экспорт.

## Что входит в P&L

Это симуляция, реальных ордеров и API-ключей биржи нет. По умолчанию: 10 000 USDT стартовый капитал, около 100 USDT на сделку, комиссия 0,055% на сторону, проскальзывание 1 bps, стоп 0,5%, цель 1,5R, максимум 15 минут. Вход использует ask для long и bid для short; выход — противоположную сторону стакана. Цена stop не гарантируется: после gap исполнение происходит по реально увиденной цене.

**Funding исключён.** Комиссия и проскальзывание — настраиваемые допущения. Нереализованный P&L неизвестен при stale quote. На бесплатном Render диск эфемерен; журнал может потеряться при замене экземпляра. Полная история сохраняется в SQLite, API/экспорт содержит общие итоги и последние 50 закрытых сделок. Для устойчивого накопления результата нужен persistent disk. Прибыль по настоящему live-потоку пока не измерена.

## Выполненные проверки

| Проверка | Результат / доказательство |
|---|---|
| Lead Engine + Astra Python | **304 passed**, 8 предупреждений о старых FastAPI hooks, 25,58 s; `docs/lead-engine/astra-results/unit-tests.txt` |
| Полный Python-набор исходного проекта и Astra | Не завершён: auto-review остановил старые dashboard AI tests из-за попытки обращения к OpenRouter. Обход запрета не выполнялся; отдельный безопасный прогон без старых dashboard/AI tests: **282 passed**, 8 предупреждений, 4,18 s (`legacy-regression-tests.txt`). Вместе с Lead Engine/Astra проверено 586 тестов; 274 старых dashboard/AI tests исключены из завершённых прогонов. |
| Реальные JS-модули в DOM/transport harness | PASS: `docs/lead-engine/astra-results/chart-tests.json` |
| EMA | Для периодов 9/18/50/200 сравнение с независимым контрольным циклом, погрешность < 1e-10; repeated forming updates + confirm + следующая свеча |
| Fib | Два направления: 90→110, r=.618 → 97.64; 110→90 → 102.36; boot-персистентность и изоляция TF |
| Свечи/очередь/маркеры | 20 incremental candle updates, 1 history request, максимум 1 pending panel frame при 1000 pushes, исходный event timestamp и price сохранены |
| Регрессии PAPER | Причинный вход, обе комиссии для long/short, insufficient depth, gap stop, восстановление журнала и запрет повторного входа |
| Изоляция/старая функциональность | Существующие isolation/API tests входят в Python-прогон; старые торговые и AI модули не переписывались |
| Синтаксис | Python compileall и `git diff --check` без ошибок |
| Реальный браузер / iPhone | Не проверен: локальный browser preview недоступен (`ERR_BLOCKED_BY_CLIENT`). DOM harness не доказывает визуальную плавность или touch UX |

Некоторые старые тесты исправлены вместе с неверными предположениями: последовательность book ID не обязана быть +1; Buy liquidation означает long; пустые потоки не считаются свежими; неполный outcome horizon не равен false. Ожидания не заменялись без соответствующего изменения протокола/логики.

## Измерения и 30 минут

Ускоренный replay из имеющейся gzip fixture обработал **1800,001 s биржевого времени**, 15 402 сообщений за **25,576 s**. Происхождение fixture как записи настоящего live-потока независимо не подтверждено. Последовательность повторена для достижения 30 минут биржевого времени. Это не 30 минут wall-clock live.

| Метрика | Фактически измерено |
|---|---|
| Replay ingestion latency | p50 0,0336 ms; p95 0,0945 ms; max 2,594 ms |
| Replay calculation latency | p50 6,968 ms; p95 8,778 ms; max 16,416 ms |
| Replay peak RSS | 66 544 KiB (около 65 MiB); короткий прогон не доказывает отсутствие утечки |
| Replay book sync | BTCUSDT и INJUSDT синхронизированы в конце |
| Replay CVD change | −48 473,731 |
| Feature history | Максимум 600 строк на инструмент |
| Live WS update rate | 0 msg/s: в попытках соединения не получено ни одного кадра |
| Live WS/network latency | Не измерена: handshake timeout. Arrival минус exchange timestamp в продукте — оценка, включающая расхождение часов, не измерение RTT |
| Расчёт backend | Настройка 250 ms / 4 Hz; фактическая live частота не подтверждена |
| UI refresh | Poll 500 ms (до 2 Hz), coalescing 300 ms, один pending frame; это настройки и тест модели, не измерение FPS на iPhone |
| PAPER refresh | Последовательный опрос страницы журнала примерно раз в 1 s |

Файлы `replay-30min.json`, `live-attempt.json`, `live-attempt-2026-09-16.json` содержат исходные замеры. Последняя попытка live: **20,017 s**, 0 сообщений, `TimeoutError: timed out during opening handshake`, `acceptance_passed: false`. Runner останавливается, когда после 20 s не пришёл ни один кадр. Его транспортные samples сами по себе не закрывают приёмку браузера и памяти.

**30-минутный live stability test НЕ ПРОЙДЕН.** Не подтверждены на настоящем потоке: memory leak, длительная синхронизация стакана, reconnect графика, scrolling и переключение на iPhone. После публикации нужен доступный Bybit и отдельный прогон; отчёт не подменяет его replay.

## Публикация и запуск

Назначение: `https://github.com/hobbit7771/-.git`, публичный пустой репозиторий, предоставленный пользователем; бренд внутри — Astra. Источник Claude остаётся отдельным remote `claude-source`; целевой remote — `astra`.

На 2026-09-16 обычный git push не получил credentials; запись через подключённый GitHub завершилась `403 Resource not accessible by integration`. Файлы в удалённый репозиторий не попали. Нужно предоставить GitHub-приложению доступ именно к новому репозиторию и разрешение Contents write, если приложение запросило его. Это права интеграции, а не добавление соавтора. [Инструкция GitHub](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps).

Render-конфигурация подготовлена для отдельного `astra-market-lead-engine`: Python, Frankfurt, Free, `pip install -r requirements.txt`, `uvicorn astra_app:app --host 0.0.0.0 --port $PORT`, healthcheck `/api/health`, `LEAD_ENGINE_ENABLED=true`. Интеграция Render требует явно подтвердить пространство `My Workspace`; выбор автоматически запрещён её ответом. Фактического deploy URL ещё нет.

## Список изменённых/добавленных файлов

Список ниже относится к сравнению с исходным commit; полный код и тестовые результаты включены в архив. Старый README перенесён без изменения содержимого в `docs/LEGACY_README.md`.

- `.gitignore`
- `ASTRA_CHANGELOG.md`
- `CURRENT_ARCHITECTURE.md`
- `Procfile`
- `README.md`
- `astra_app.py`
- `docs/LEGACY_README.md`
- `docs/lead-engine/astra-results/chart-tests.json`
- `docs/lead-engine/astra-results/full-tests.txt`
- `docs/lead-engine/astra-results/legacy-regression-tests.txt`
- `docs/lead-engine/astra-results/live-attempt-2026-09-16.json`
- `docs/lead-engine/astra-results/live-attempt-2026-09-16.txt`
- `docs/lead-engine/astra-results/live-attempt.json`
- `docs/lead-engine/astra-results/replay-30min.json`
- `docs/lead-engine/astra-results/unit-tests.txt`
- `render.yaml`
- `t3_engine/dashboard/static/astra.css`
- `t3_engine/dashboard/static/astra.html`
- `t3_engine/dashboard/static/astra.js`
- `t3_engine/dashboard/static/astra_paper.html`
- `t3_engine/dashboard/static/astra_paper.js`
- `t3_engine/dashboard/static/lead_blocks.js`
- `t3_engine/dashboard/static/lead_chart_math.js`
- `t3_engine/dashboard/static/lead_engine.css`
- `t3_engine/dashboard/static/lead_engine.js`
- `t3_engine/dashboard/static/lead_events.js`
- `t3_engine/dashboard/static/lead_fib.js`
- `t3_engine/dashboard/static/lead_panel.js`
- `t3_engine/dashboard/static/lead_workspace.css`
- `t3_engine/dashboard/static/lead_workspace.html`
- `t3_engine/dashboard/static/lead_workspace.js`
- `t3_engine/lead_engine/api.py`
- `t3_engine/lead_engine/btc_leadlag.py`
- `t3_engine/lead_engine/bybit_ws.py`
- `t3_engine/lead_engine/calibration.py`
- `t3_engine/lead_engine/candles_rest.py`
- `t3_engine/lead_engine/config.py`
- `t3_engine/lead_engine/elliott_state.py`
- `t3_engine/lead_engine/engine.py`
- `t3_engine/lead_engine/health.py`
- `t3_engine/lead_engine/layers.py`
- `t3_engine/lead_engine/liquidation_engine.py`
- `t3_engine/lead_engine/normalize.py`
- `t3_engine/lead_engine/orderbook_engine.py`
- `t3_engine/lead_engine/paper_trading.py`
- `t3_engine/lead_engine/prebreak_engine.py`
- `t3_engine/lead_engine/replay.py`
- `t3_engine/lead_engine/rolling.py`
- `t3_engine/lead_engine/signal_machine.py`
- `t3_engine/lead_engine/smc_engine.py`
- `t3_engine/lead_engine/state.py`
- `t3_engine/lead_engine/storage.py`
- `t3_engine/lead_engine/trade_flow.py`
- `tests/js/lead_chart.test.cjs`
- `tests/test_astra_app.py`
- `tests/test_astra_integrity.py`
- `tests/test_lead_engine.py`
- `tests/test_lead_engine_api.py`
- `tests/test_lead_engine_external.py`
- `tests/test_lead_engine_pipeline.py`
- `tests/test_lead_engine_replay_integration.py`
- `tools/astra_stability.py`
