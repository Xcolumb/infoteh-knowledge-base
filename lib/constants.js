// Единый источник справочников и правил доступа.
// Раньше роли, типы и статусы дублировались в server.js и frontend-html/app.js.

export const ROLES = ['Монтажник', 'Старший монтажник', 'Инженер ПТО', 'Администратор'];

export const ADMIN_ONLY = ['Администратор'];
export const CONTENT_MANAGERS = ['Администратор', 'Старший монтажник'];
export const PTO_MANAGERS = ['Администратор', 'Инженер ПТО'];

export const PTO_TYPES = [
  'Исполнительная документация',
  'ППР',
  'Акт скрытых работ',
  'Журнал работ',
  'Входной контроль'
];

export const PTO_STATUSES = [
  'Черновик',
  'На проверке',
  'На согласовании',
  'Утверждён',
  'Отклонён',
  'В архиве'
];

// Статусы, при которых документ считается «закрытым» (не просрочен и не в работе).
export const PTO_CLOSED_STATUSES = ['Утверждён', 'В архиве'];

export const REMARK_STATUSES_DEFAULT = ['Новое', 'В работе', 'Устранено', 'Закрыто', 'Отклонено'];
export const REMARK_CLOSED_STATUSES = ['Закрыто', 'Отклонено'];

export const NOTIFICATION_TYPES = {
  DOC_DUE_SOON: 'Документ: срок приближается',
  DOC_OVERDUE: 'Документ: просрочен',
  DOC_STATUS_CHANGED: 'Документ: изменён статус',
  DOC_ASSIGNED: 'Документ: назначен ответственный',
  REMARK_NEW: 'Новое замечание',
  REMARK_DUE_SOON: 'Замечание: срок приближается',
  REMARK_OVERDUE: 'Замечание: просрочено',
  COMPLETENESS_INCOMPLETE: 'Комплект ИД: неполный состав'
};

// Разрешённые расширения для загрузки. Проверяется и расширение, и MIME-тип.
export const ALLOWED_UPLOAD_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.md', '.csv', '.jpg', '.jpeg', '.png'];

export const MIME_BY_EXTENSION = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
};

// Соответствие «расширение → класс файла» для логики извлечения текста.
export const TEXT_EXTRACTORS = {
  pdf: ['.pdf'],
  docx: ['.docx'],
  xlsx: ['.xlsx'],
  text: ['.txt', '.md', '.csv']
};

export function isPtoStatus(value) {
  return PTO_STATUSES.includes(value);
}

export function isPtoType(value) {
  return PTO_TYPES.includes(value);
}

export function isRole(value) {
  return ROLES.includes(value);
}
