import { useEffect, useState } from 'react';
import './App.css';

type ServiceName = 'postgres' | 'redis' | 'storage';
type ServiceStatus = 'up' | 'down';

interface ServiceHealth {
  status: ServiceStatus;
  latencyMs?: number;
}

interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: string;
  services: Record<ServiceName, ServiceHealth>;
}

const API_URL =
  import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

const SERVICE_NAMES: ServiceName[] = [
  'postgres',
  'redis',
  'storage',
];

const SERVICE_LABELS: Record<ServiceName, string> = {
  postgres: 'PostgreSQL',
  redis: 'Redis',
  storage: 'MinIO',
};

function App() {
  const [health, setHealth] =
    useState<HealthResponse | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadHealth = async () => {
      try {
        const response = await fetch(`${API_URL}/health`);
        const data = (await response.json()) as HealthResponse;

        if (!response.ok && response.status !== 503) {
          throw new Error(`HTTP ${response.status}`);
        }

        if (!cancelled) {
          setHealth(data);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
          setError('Не удалось подключиться к API');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadHealth();

    const intervalId = window.setInterval(() => {
      void loadHealth();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const summaryText = isLoading
    ? 'Проверяем инфраструктуру...'
    : error
      ? 'API недоступен'
      : health?.status === 'ok'
        ? 'Все системы работают'
        : 'Обнаружены неполадки';

  const summaryStatus = isLoading
    ? 'loading'
    : error || health?.status === 'error'
      ? 'down'
      : 'up';

  return (
    <main className="page">
      <section className="dashboard">
        <header className="header">
          <div>
            <p className="eyebrow">Cloud Storage</p>
            <h1>Состояние системы</h1>
            <p className="description">
              Автоматическая проверка инфраструктуры каждые
              пять секунд.
            </p>
          </div>

          <div className={`summary summary--${summaryStatus}`}>
            <span className="status-dot" />
            {summaryText}
          </div>
        </header>

        {error ? (
          <div className="error-message">
            <strong>{error}</strong>
            <span>
              Проверьте, что API запущен по адресу {API_URL}.
            </span>
          </div>
        ) : (
          <div className="service-grid">
            {SERVICE_NAMES.map((name) => {
              const service = health?.services[name];
              const status = service?.status ?? 'down';

              return (
                <article
                  className={`service-card service-card--${status}`}
                  key={name}
                >
                  <div className="service-card__header">
                    <h2>{SERVICE_LABELS[name]}</h2>
                    <span className={`badge badge--${status}`}>
                      {status === 'up' ? 'Работает' : 'Недоступен'}
                    </span>
                  </div>

                  <p className="service-card__role">
                    {name === 'postgres' &&
                      'Хранение метаданных'}
                    {name === 'redis' &&
                      'Кэш и очереди задач'}
                    {name === 'storage' &&
                      'Объектное хранилище'}
                  </p>

                  <div className="latency">
                    <span>Время ответа</span>
                    <strong>
                      {service?.latencyMs !== undefined
                        ? `${service.latencyMs} мс`
                        : '—'}
                    </strong>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <footer className="footer">
          {health ? (
            <>
              Последняя проверка:{' '}
              <time dateTime={health.timestamp}>
                {new Date(health.timestamp).toLocaleString()}
              </time>
            </>
          ) : (
            'Данные пока не получены'
          )}
        </footer>
      </section>
    </main>
  );
}

export default App;