import { describe, expect, test } from "vitest";
import {
  COMMENT_BODY_MAX,
  extractMentionUserIds,
  isCommentAnchorType,
} from "../server/lib/comment-mentions";
import { activeMentionQuery, insertMentionToken, splitMentionSegments } from "../src/lib/mentions";

describe("extractMentionUserIds", () => {
  test("extracts unique user ids from @[id] tokens", () => {
    expect(extractMentionUserIds("hi @[user_a] and @[user_b] and @[user_a]")).toEqual([
      "user_a",
      "user_b",
    ]);
  });

  test("ignores plain @names, emails, and malformed tokens", () => {
    expect(extractMentionUserIds("hi @alice, mail me at bob@example.com, @[]")).toEqual([]);
  });

  test("accepts ids with dots, colons, and dashes", () => {
    expect(extractMentionUserIds("@[user:abc-1.2_x]")).toEqual(["user:abc-1.2_x"]);
  });
});

describe("isCommentAnchorType", () => {
  test("accepts the three anchor kinds and rejects others", () => {
    expect(isCommentAnchorType("general")).toBe(true);
    expect(isCommentAnchorType("line")).toBe(true);
    expect(isCommentAnchorType("finding")).toBe(true);
    expect(isCommentAnchorType("inline")).toBe(false);
    expect(isCommentAnchorType(42)).toBe(false);
  });

  test("body cap is sane", () => {
    expect(COMMENT_BODY_MAX).toBe(4000);
  });
});

describe("splitMentionSegments", () => {
  test("splits text around mention tokens", () => {
    expect(splitMentionSegments("hi @[u1], meet @[u2]")).toEqual([
      { type: "text", text: "hi " },
      { type: "mention", userId: "u1" },
      { type: "text", text: ", meet " },
      { type: "mention", userId: "u2" },
    ]);
  });

  test("returns a single text segment when there are no mentions", () => {
    expect(splitMentionSegments("plain text")).toEqual([{ type: "text", text: "plain text" }]);
  });
});

describe("activeMentionQuery", () => {
  test("detects an in-progress mention at the caret", () => {
    expect(activeMentionQuery("hello @al", 9)).toEqual({ start: 6, query: "al" });
  });

  test("ignores mid-word @ such as emails", () => {
    expect(activeMentionQuery("bob@example", 11)).toBeNull();
  });

  test("ignores completed tokens", () => {
    const text = "hi @[user_a";
    expect(activeMentionQuery(text, text.length)).toBeNull();
  });
});

describe("insertMentionToken", () => {
  test("replaces the partial query with a token and moves the caret", () => {
    const result = insertMentionToken("hello @al there", 9, 6, "user_a");
    expect(result.text).toBe("hello @[user_a]  there");
    expect(result.caret).toBe("hello @[user_a] ".length);
  });
});
