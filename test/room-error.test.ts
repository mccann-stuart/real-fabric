import { describe, expect, it } from "vitest";
import { decodeRoomError, roomError } from "../src/worker/roomError";

describe("roomError and decodeRoomError", () => {
  it("creates a properly formatted Error instance with roomError", () => {
    const err = roomError(404, "room_not_found", "Room is not initialised.");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("RF-ROOM-ERROR|404|room_not_found|Room is not initialised.");
  });

  it("handles edge cases in roomError including empty message, special characters, unicode, and status/code variations", () => {
    const emptyErr = roomError(500, "internal_error", "");
    expect(emptyErr).toBeInstanceOf(Error);
    expect(emptyErr.message).toBe("RF-ROOM-ERROR|500|internal_error|");
    expect(decodeRoomError(emptyErr)).toEqual({
      status: 500,
      code: "internal_error",
      message: "",
    });

    const unicodeMsg = "Error in room 🚀: invalid state | check parameters";
    const unicodeErr = roomError(422, "unprocessable_entity", unicodeMsg);
    expect(unicodeErr.message).toBe(`RF-ROOM-ERROR|422|unprocessable_entity|${unicodeMsg}`);
    expect(decodeRoomError(unicodeErr)).toEqual({
      status: 422,
      code: "unprocessable_entity",
      message: unicodeMsg,
    });

    const customCodeErr = roomError(200, "ok_status", "OK");
    expect(customCodeErr.message).toBe("RF-ROOM-ERROR|200|ok_status|OK");
    expect(decodeRoomError(customCodeErr)).toEqual({
      status: 200,
      code: "ok_status",
      message: "OK",
    });
  });

  it("decodes valid room errors created via roomError", () => {
    const err = roomError(401, "participant_auth_failed", "Invalid credentials.");
    const decoded = decodeRoomError(err);
    expect(decoded).toEqual({
      status: 401,
      code: "participant_auth_failed",
      message: "Invalid credentials.",
    });
  });

  it("decodes room errors containing multiline messages or special characters", () => {
    const multilineMessage = "Line 1\nLine 2\nLine 3|with|pipes";
    const err = roomError(400, "invalid_request", multilineMessage);
    const decoded = decodeRoomError(err);
    expect(decoded).toEqual({
      status: 400,
      code: "invalid_request",
      message: multilineMessage,
    });
  });

  it("returns null for non-Error inputs", () => {
    expect(decodeRoomError(null)).toBeNull();
    expect(decodeRoomError(undefined)).toBeNull();
    expect(decodeRoomError(123)).toBeNull();
    expect(decodeRoomError("RF-ROOM-ERROR|404|room_not_found|Room not found")).toBeNull();
    expect(
      decodeRoomError({ message: "RF-ROOM-ERROR|404|room_not_found|Room not found" }),
    ).toBeNull();
  });

  it("returns null for standard Error instances without the room error sentinel", () => {
    const standardErr = new Error("General runtime error");
    expect(decodeRoomError(standardErr)).toBeNull();
  });

  it("returns null for malformed room error messages", () => {
    // Wrong sentinel
    expect(decodeRoomError(new Error("WRONG-SENTINEL|404|room_not_found|Msg"))).toBeNull();

    // Invalid status (not 3 digits)
    expect(decodeRoomError(new Error("RF-ROOM-ERROR|40|room_not_found|Msg"))).toBeNull();
    expect(decodeRoomError(new Error("RF-ROOM-ERROR|1234|room_not_found|Msg"))).toBeNull();

    // Invalid code format (uppercase letters, spaces, etc.)
    expect(decodeRoomError(new Error("RF-ROOM-ERROR|404|ROOM_NOT_FOUND|Msg"))).toBeNull();
    expect(decodeRoomError(new Error("RF-ROOM-ERROR|404|room-not-found|Msg"))).toBeNull();

    // Missing fields
    expect(decodeRoomError(new Error("RF-ROOM-ERROR|404"))).toBeNull();
    expect(decodeRoomError(new Error("RF-ROOM-ERROR|404|room_not_found"))).toBeNull();
  });
});
