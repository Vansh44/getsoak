import { Search } from "lucide-react";

export default function HelpSearchLoading() {
  return (
    <main className="hc-main">
      <div className="hc-wrap">
        <div className="hc-search-loading" role="status">
          <Search size={20} aria-hidden />
          Understanding your question and checking published guides…
        </div>
      </div>
    </main>
  );
}
