export default function LoginPage() {
  return (
    <main>
      <h1>Personal CFO sign in</h1>
      <form action="/api/v1/auth/login" method="post">
        <label>
          Login
          <input name="login" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
