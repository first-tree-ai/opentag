import { type NavigateOptions, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Navigates once per destination.
 *
 * The router's own `Navigate` compares its props by reference, and JSX rebuilds that object on
 * every render, so it re-navigates on each pass. Because the router keeps the outgoing route
 * mounted while the next one loads, a gate that redirects from its own render turns that into an
 * unbounded loop. Serializing the destination fires the navigation again only when the destination
 * actually changes, which also means every destination has to be plain data — no function updaters.
 */
export function Redirect(options: NavigateOptions) {
  const navigate = useNavigate();
  const destination = JSON.stringify(options);
  useEffect(() => {
    void navigate(JSON.parse(destination) as NavigateOptions);
  }, [destination, navigate]);
  return null;
}
