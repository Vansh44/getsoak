"use client";

import { useState, useTransition, useEffect } from "react";
import Link from "next/link";
import { Bell, ChevronRight, Package } from "lucide-react";
import { useRouter } from "next/navigation";
import { updateCustomerProfile } from "@/app/actions/customer-profile";
import { useAuth } from "@/app/(storefront)/components/auth/AuthProvider";
import AddressBook from "./address-book";
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

  if (loading || !user) {
    return (
      <div
        className={styles.container}
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <div className={styles.subtitle}>Loading profile...</div>
      </div>
    );
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

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div className={styles.header}>
          <h1 className={styles.title}>Account Overview</h1>
          <p className={styles.subtitle}>Manage your personal information.</p>
        </div>

        <div className={styles.grid} style={{ gridTemplateColumns: "1fr" }}>
          {/* Personal Information Card */}
          <div className={styles.card}>
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

              <div
                className={styles.inputGroup}
                style={{ marginBottom: "20px" }}
              >
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
                  title="Phone number cannot be changed here"
                />
              </div>

              <button
                type="submit"
                className={styles.submitBtn}
                disabled={isPendingProfile}
              >
                {isPendingProfile ? "Saving..." : "Save Changes"}
              </button>
            </form>
          </div>

          {/* Quick links into the rest of the account area. Orders and
              notifications are their own pages — this is just the signpost. */}
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>My activity</h2>
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

          {/* Address Book Card */}
          <AddressBook />
        </div>
      </div>
    </div>
  );
}
