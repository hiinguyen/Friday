export const STATUS = {
  bad_input: 400, url_blocked: 400, unauthorized: 401, forbidden: 403, not_found: 404, busy: 409, cancelled: 409, too_many: 429,
  internal: 500, export_failed: 500, url_failed: 502, agent_bad_output: 502, agent_error: 502,
  agent_unavailable: 503, agent_timeout: 504,
};

export const DEFAULT_MESSAGES = {
  bad_input: 'Tệp hoặc nội dung không hợp lệ.',
  url_blocked: 'Không được phép tải địa chỉ này.',
  url_failed: 'Không tải được trang web.',
  unauthorized: 'Cần mã truy cập hợp lệ.',
  forbidden: 'Yêu cầu không được phép từ nguồn này.',
  not_found: 'Không tìm thấy.',
  too_many: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
  busy: 'AI đang xử lý dự án này, vui lòng đợi.',
  cancelled: 'Đã huỷ yêu cầu.',
  internal: 'Lỗi máy chủ.',
  export_failed: 'Xuất tệp thất bại.',
  agent_bad_output: 'AI trả về dữ liệu không hợp lệ. Hãy thử lại.',
  agent_error: 'AI báo lỗi.',
  agent_unavailable: 'Chưa cấu hình AI.',
  agent_timeout: 'AI trả lời quá lâu nên đã bị dừng. Hãy thử lại.',
};

export class AppError extends Error {
  constructor(code, message = DEFAULT_MESSAGES[code], { detail } = {}) {
    super(message ?? DEFAULT_MESSAGES.internal);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code] ?? STATUS.internal;
    this.detail = detail ?? null;
  }
}

export function toEnvelope(error) {
  const code = error instanceof AppError ? error.code : 'internal';
  const message = error instanceof AppError ? error.message : DEFAULT_MESSAGES.internal;
  return { ok: false, error: { code, message } };
}

export function ok(data) {
  return { ok: true, data };
}
