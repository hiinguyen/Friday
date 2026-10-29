export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const NETWORK_MESSAGE = 'Không kết nối được máy chủ.';

function filenameFrom(header) {
  if (!header) return 'diagram';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return encoded[1];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : 'diagram';
}

export function createApi({ fetchImpl = fetch, getToken = () => null, onUnauthorized = () => {} } = {}) {
  async function request(path, { method = 'GET', body, form, raw = false } = {}) {
    const headers = {};
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const init = { method, headers };
    if (form) init.body = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetchImpl(path, init);
    } catch {
      throw new ApiError('network', NETWORK_MESSAGE, 0);
    }
    if (response.status === 401) onUnauthorized();
    if (raw) return response;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || !payload || payload.ok !== true) {
      const error = payload?.error ?? { code: 'internal', message: 'Lỗi máy chủ.' };
      throw new ApiError(error.code, error.message, response.status);
    }
    return payload.data;
  }

  const sectionPath = (id, sectionId) => `/api/projects/${encodeURIComponent(id)}/sections/${encodeURIComponent(sectionId)}`;

  return {
    health: () => request('/api/health'),
    listProjects: () => request('/api/projects'),
    createFromText: (text) => request('/api/projects', { method: 'POST', body: { text } }),
    createFromUrl: (url) => request('/api/projects', { method: 'POST', body: { url } }),
    createFromFile: (file) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return request('/api/projects', { method: 'POST', form });
    },
    getProject: (id) => request(`/api/projects/${encodeURIComponent(id)}`),
    deleteProject: (id) => request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    segment: (id, answers) => request(`/api/projects/${encodeURIComponent(id)}/segment`, { method: 'POST', body: { answers } }),
    addSection: (id, blockIds) => request(`/api/projects/${encodeURIComponent(id)}/sections`, { method: 'POST', body: { blockIds } }),
    generate: (id, sectionId, answers) => request(`${sectionPath(id, sectionId)}/generate`, { method: 'POST', body: { answers } }),
    saveDiagram: (id, sectionId, spec) => request(`${sectionPath(id, sectionId)}/diagram`, { method: 'PUT', body: { spec } }),
    refine: (id, sectionId, spec, instruction) => request(`${sectionPath(id, sectionId)}/refine`, { method: 'POST', body: { spec, instruction } }),
    cancel: (id) => request(`/api/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

    async exportFile(id, { format, sections, transparent } = {}) {
      const params = new URLSearchParams({ format });
      if (sections && sections.length > 0) params.set('sections', sections.join(','));
      if (transparent) params.set('transparent', '1');
      const response = await request(`/api/projects/${encodeURIComponent(id)}/export?${params.toString()}`, { raw: true });
      if (!response.ok) {
        let error = { code: 'export_failed', message: 'Xuất tệp thất bại.' };
        try {
          const payload = await response.json();
          if (payload?.error) error = payload.error;
        } catch {
          /* keep the generic export error */
        }
        throw new ApiError(error.code, error.message, response.status);
      }
      const blob = await response.blob();
      return { blob, filename: filenameFrom(response.headers.get('content-disposition')) };
    },
  };
}
