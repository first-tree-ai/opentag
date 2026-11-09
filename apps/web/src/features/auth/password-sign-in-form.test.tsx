import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { PasswordSignInForm } from "./password-sign-in-form.js";

const CARD = "/im-feedback/1a63a21e-f6c7-4474-91ea-4dabf0566a24";

afterEach(() => vi.restoreAllMocks());
describe("password sign-in destination", () => {
  it.each(["settings", "task", "restore", "agent"])("returns to an IM card link opening %s", async (open) => {
    vi.spyOn(browserApi, "signInWithPassword").mockResolvedValue(undefined);
    const navigate = vi.fn();
    const next = `${CARD}?open=${open}`;
    render(<PasswordSignInForm next={next} navigate={navigate} />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a-long-password" } });
    const form = screen.getByLabelText("Email").closest("form");
    if (!form) throw new Error("Expected a sign-in form");
    fireEvent.submit(form);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(next));
  });
});
