// Единая точка расширения для ИИ. Внешние провайдеры не подключены:
// по умолчанию используется заглушка, которая честно сообщает об отключении.
// Никакие документы наружу не передаются.
import config from '../../config.js';

class DisabledProvider {
  constructor() {
    this.id = 'none';
  }

  get enabled() {
    return false;
  }

  async complete() {
    const error = new Error('ИИ-провайдер не подключён. Включение выполняется отдельным решением организации.');
    error.code = 'AI_DISABLED';
    error.status = 501;
    throw error;
  }
}

class CompatibleProvider extends DisabledProvider {
  constructor(settings) {
    super();
    this.id = settings.provider;
    this.settings = settings;
    this.enabled = false; // Пока не реализован транспорт: только архитектурная заготовка.
  }

  async complete() {
    const error = new Error('Провайдер ИИ задан в конфигурации, но интеграция не реализована в этой версии.');
    error.code = 'AI_NOT_IMPLEMENTED';
    error.status = 501;
    throw error;
  }
}

export function createAiProvider(settings = config.ai) {
  if (!settings.enabled) return new DisabledProvider();
  return new CompatibleProvider(settings);
}

export function describeAi() {
  return {
    enabled: Boolean(config.ai.enabled),
    provider: config.ai.provider,
    model: config.ai.model || null,
    note: config.ai.enabled
      ? 'Провайдер задан, но транспорт не реализован: требуется согласование и разработка.'
      : 'ИИ отключён. Документы не передаются внешним сервисам.',
    planned: [
      'Поиск по проектной документации с цитатами',
      'Извлечение реквизитов из актов и протоколов',
      'Черновики писем и запросов',
      'Сравнение редакций документов',
      'Сводки и отчёты',
      'Помощник по базе знаний'
    ]
  };
}

export default { createAiProvider, describeAi };
