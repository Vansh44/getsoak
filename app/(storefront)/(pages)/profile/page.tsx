"use client";

import { useState, useTransition, useEffect } from "react";
import Link from "next/link";
import { Bell, ChevronRight, Package } from "lucide-react";
import { useRouter } from "next/navigation";
import { updateCustomerProfile } from "@/app/actions/customer-profile";
import { useAuth } from "@/app/(storefront)/components/auth/AuthProvider";
import AddressBook from "./address-book";
import CreditBalance from "./credit-balance";
import ProfileSkeleton from "./profile-skeleton";
import styles from "./profile.module.css";

export default function ProfilePage() {
  const router = useRouter();
  const { user, customer, loading, refreshCustomer } = useAuth();

  const [isPendingProfile, startTransitionProfile] = useTransition();

  const [profileStatus, setProfileStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [user, loading, router]);

  // Also covers the signed-out moment before the effect above redirects, so a
  // visitor never sees a bare "not signed in" flash on the way out.
  if (loading || !user) {
    return <ProfileSkeleton />;
  }

  const handleProfileUpdate = (formData: FormData) => {
    setProfileStatus(null);
    startTransitionProfile(async () => {
      const result = await updateCustomerProfile(formData);
      if (result.error) {
        setProfileStatus({ type: "error", message: result.error });
      } else {
        setProfileStatus({
          type: "success",
          message: "Profile updated successfully.",
        });
        await refreshCustomer();
        router.refresh();
      }
    });
  };

  // Whoever this is, greet them by the best name we have. Falling back to the
  // email local part beats "Account Overview" over an empty subtitle.
  const fullName = [customer?.first_name, customer?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const displayName = fullName || user?.email?.split("@")[0] || "Your account";
  const initial = (fullName || user?.email || "?").trim().charAt(0);

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div className={styles.header}>
          <span className={styles.avatar} aria-hidden="true">
            {initial}
          </span>
          <div className={styles.headerText}>
            <h1 className={styles.title}>{displayName}</h1>
            {user?.email && <p className={styles.subtitle}>{user.email}</p>}
          </div>
        </div>

        <div className={styles.layout}>
          {/* What you came to EDIT. */}
          <div className={styles.mainCol}>
            {/* Personal Information Card. The slot* class carries nothing but
                a mobile `order` — see the display:contents note in the CSS. */}
            <div className={`${styles.card} ${styles.slotPersonal}`}>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>Personal Information</h2>
                <p className={styles.cardSubtitle}>
                  Update your name and email address.
                </p>
              </div>

              {profileStatus && (
                <div
                  className={`${styles.statusMessage} ${styles[profileStatus.type]}`}
                >
                  {profileStatus.message}
                </div>
              )}

              <form action={handleProfileUpdate} className={styles.form}>
                <div className={styles.formRow}>
                  <div className={styles.inputGroup}>
                    <label htmlFor="firstName" className={styles.label}>
                      First Name
                    </label>
                    <input
                      type="text"
                      id="firstName"
                      name="firstName"
                      defaultValue={customer?.first_name || ""}
                      className={styles.input}
                      required
                      disabled={isPendingProfile}
                    />
                  </div>

                  <div className={styles.inputGroup}>
                    <label htmlFor="lastName" className={styles.label}>
                      Last Name
                    </label>
                    <input
                      type="text"
                      id="lastName"
                      name="lastName"
                      defaultValue={customer?.last_name || ""}
                      className={styles.input}
                      disabled={isPendingProfile}
                    />
                  </div>
                </div>

                <div className={styles.inputGroup}>
                  <label htmlFor="email" className={styles.label}>
                    Email Address
                  </label>
                  <input
                    type="email"
                    id="email"
                    name="email"
                    defaultValue={user?.email || ""}
                    className={styles.input}
                    disabled={isPendingProfile}
                  />
                </div>

                <div className={styles.inputGroup}>
                  <label htmlFor="phone" className={styles.label}>
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    id="phone"
                    name="phone"
                    defaultValue={user?.phone || ""}
                    className={styles.input}
                    disabled
                  />
                  <span className={styles.hint}>
                    Your phone number is how you sign in, so it can&apos;t be
                    changed here.
                  </span>
                </div>

                <div className={styles.formActions}>
                  <button
                    type="submit"
                    className={styles.submitBtn}
                    disabled={isPendingProfile}
                  >
                    {isPendingProfile ? "Saving..." : "Save Changes"}
                  </button>
                </div>
              </form>
            </div>

            {/* Address Book Card. AddressBook renders its own .card, so the
                slot has to be a wrapper here rather than a class on the card. */}
            <div className={styles.slotAddress}>
              <AddressBook />
            </div>
          </div>

          {/* What you came to CHECK. */}
          <aside className={styles.sideCol}>
            {/* Store credit. Renders itself away when the shopper has none, so
                it can sit top-right without cluttering the common case — and
                first, not fourth, once the columns stack on a phone. It carries
                its own slot class; see the note in credit-balance.tsx. */}
            <CreditBalance />

            {/* Quick links into the rest of the account area. Orders and
                notifications are their own pages — this is just the signpost. */}
            <div className={`${styles.card} ${styles.slotActivity}`}>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>My activity</h2>
              </div>
              <div className={styles.quickLinks}>
                <Link href="/orders" className={styles.quickLink}>
                  <Package size={18} strokeWidth={1.75} />
                  <span>
                    <strong>My orders</strong>
                    <small>Track deliveries and download invoices</small>
                  </span>
                  <ChevronRight size={16} />
                </Link>
                <Link href="/notifications" className={styles.quickLink}>
                  <Bell size={18} strokeWidth={1.75} />
                  <span>
                    <strong>Notifications</strong>
                    <small>Updates about your orders and account</small>
                  </span>
                  <ChevronRight size={16} />
                </Link>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
