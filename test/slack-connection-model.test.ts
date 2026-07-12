import { describe, expect, test } from "vitest";
import { getMissingSlackChannelOption } from "../src/models/slack-connection";

const connection = {
  teamId: "T123",
  teamName: "Drydock",
  channelId: "C_RELEASES",
  channelName: "package-releases",
  canListChannels: true,
  enabled: true,
  createdAt: "2026-07-12T00:00:00.000Z",
};

describe("getMissingSlackChannelOption", () => {
  test("keeps the saved channel available while the channel list loads", () => {
    expect(getMissingSlackChannelOption(connection, [])).toEqual({
      id: "C_RELEASES",
      name: "package-releases",
    });
  });

  test("does not duplicate the saved channel once Slack returns it", () => {
    expect(
      getMissingSlackChannelOption(connection, [
        { id: "C_ANNOUNCEMENTS", name: "announcements" },
        { id: "C_RELEASES", name: "package-releases" },
      ]),
    ).toBeNull();
  });

  test("does not invent an option for a manually entered channel ID", () => {
    expect(getMissingSlackChannelOption({ ...connection, channelName: null }, [])).toBeNull();
  });
});
