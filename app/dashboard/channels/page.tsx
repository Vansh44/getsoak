import { requireSectionAccess } from "../lib/access";
import { getChannelState } from "@/app/actions/payment-provider-actions";
import { getShiprocketChannelState } from "@/app/actions/logistics-provider-actions";
import { ChannelsClient } from "./channels-client";

export const metadata = { title: "Channels" };

export default async function ChannelsPage() {
  const access = await requireSectionAccess("channels", "view");
  const [paymentState, shiprocketState] = await Promise.all([
    getChannelState(),
    getShiprocketChannelState(),
  ]);
  return (
    <ChannelsClient
      initialState={paymentState}
      initialShiprocketState={shiprocketState}
      canManage={access.can("channels", "manage")}
    />
  );
}
