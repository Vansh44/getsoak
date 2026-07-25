import Link from "next/link";
import "./not-found.css";

// Dashboard-scoped 404. Without this, any notFound() inside /dashboard/* (e.g.
// a product/order that can't be loaded) bubbles all the way to the ROOT
// not-found — which says "This store doesn't exist" and drops the dashboard
// chrome, badly misleading an operator whose store is perfectly fine. This
// boundary keeps them inside the dashboard with an accurate message.
export const metadata = { title: "Not found" };

export default function DashboardNotFound() {
  return (
    <div className="dash-page-enter dash404">
      <div className="dash404-inner">
        <div className="dash404-art" aria-hidden="true">
          <div className="dash404-panel">
            <div className="dash404-panel-head">
              <span />
              <span />
            </div>
            <div className="dash404-row">
              <i />
              <b />
              <s />
            </div>
            <div className="dash404-row is-missing">
              <i />
              <b />
            </div>
            <div className="dash404-row">
              <i />
              <b />
              <s />
            </div>
          </div>
          <span className="dash404-badge">404</span>
        </div>

        <h1 className="dash404-title">We couldn&rsquo;t find that</h1>
        <p className="dash404-text">
          This item may have been deleted, or you may not have access to it on
          this store. It hasn&rsquo;t affected the rest of your dashboard.
        </p>

        <div className="dash404-actions">
          <Link
            href="/dashboard/products"
            className="dash-btn dash-btn-primary"
          >
            Back to products
          </Link>
          <Link href="/dashboard" className="dash-btn dash-btn-ghost">
            Dashboard home
          </Link>
        </div>
      </div>
    </div>
  );
}
