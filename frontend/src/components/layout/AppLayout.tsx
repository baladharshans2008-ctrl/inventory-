import { Outlet, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { TopNav } from "./TopNav";
import { Footer } from "./Footer";

export function AppLayout() {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen flex-col">
      <TopNav />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
