import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError } from '../auth/auth-api';
import { useAuth } from '../auth/useAuth';
import './AuthPage.css';

export function RegisterPage() {
  const navigate = useNavigate();
  const { register } = useAuth();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] =
    useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (password !== passwordConfirmation) {
      setError('Пароли не совпадают');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const normalizedDisplayName = displayName.trim();

      await register({
        email,
        password,
        displayName: normalizedDisplayName || undefined,
      });

      void navigate('/', { replace: true });
    } catch (requestError) {
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : 'Не удалось зарегистрироваться',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-card__heading">
          <p className="auth-eyebrow">Cloud Storage</p>
          <h1>Регистрация</h1>
          <p>Создайте аккаунт для хранения файлов.</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            Отображаемое имя
            <input
              type="text"
              value={displayName}
              onChange={(event) =>
                setDisplayName(event.target.value)
              }
              autoComplete="name"
              maxLength={100}
            />
          </label>

          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              maxLength={254}
              required
            />
          </label>

          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
          </label>

          <label>
            Повторите пароль
            <input
              type="password"
              value={passwordConfirmation}
              onChange={(event) =>
                setPasswordConfirmation(event.target.value)
              }
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
          </label>

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? 'Создаём аккаунт…'
              : 'Создать аккаунт'}
          </button>
        </form>

        <p className="auth-switch">
          Уже есть аккаунт? <Link to="/login">Войти</Link>
        </p>
      </section>
    </main>
  );
}