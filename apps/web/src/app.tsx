import { BrowserRouter } from "react-router-dom";
import { AppRouter } from "./router.js";

export function App() {
  return (
    <BrowserRouter>
      <AppRouter />
    </BrowserRouter>
  );
}
