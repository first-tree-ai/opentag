import { Link } from "react-router-dom";

export function UnavailablePage({ title }: { title: string }) {
  return (
    <main className="center-card">
      <h1>{title}</h1>
      <p>This capability is not available in the current release.</p>
      <Link to="/agents">Back to Agents</Link>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <main className="center-card">
      <h1>Page not found</h1>
      <p>The requested OpenTag page is not available.</p>
      <Link to="/agents">Back to Agents</Link>
    </main>
  );
}
