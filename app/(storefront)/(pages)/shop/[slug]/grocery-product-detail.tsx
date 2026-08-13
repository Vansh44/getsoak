"use client";

import Link from "next/link";
import Image from "next/image";
import { ImageIcon, Truck, RotateCcw, Sprout, Minus } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { formatPrice, hasSpecialPrice } from "@/lib/pricing";
import { RatingStars } from "./reviews-section";
import type { DetailProduct, DetailVariant } from "./product-detail-client";

// The Basket (grocery) product-detail hero — a premium grocery layout used
// ONLY when the store's theme sets layout.storefront = "grocery". Entirely
// separate markup + `gpdp-*` classes from the classic PDP, so the WholeSip
// storefront is untouched. The controller (product-detail-client) owns all
// state; this component is presentational.
export function GroceryProductDetail({
  product,
  gallery,
  activeImg,
  setActiveImg,
  onZoom,
  averageRating,
  reviewCount,
  hasVariants,
  variantId,
  selectVariant,
  base,
  selling,
  discount,
  outOfStock,
  qty,
  setQuantity,
  maxQty,
  onAddToCart,
  onBuyNow,
  deliveryEstimator,
}: {
  product: DetailProduct;
  gallery: string[];
  activeImg: string | null;
  setActiveImg: (u: string) => void;
  onZoom: () => void;
  averageRating: number;
  reviewCount: number;
  hasVariants: boolean;
  variantId: string | null;
  selectVariant: (v: DetailVariant) => void;
  base: number;
  selling: number;
  discount: number;
  outOfStock: boolean;
  qty: number;
  setQuantity: (n: number) => void;
  maxQty: number;
  onAddToCart: () => void;
  onBuyNow: () => void;
  deliveryEstimator: ReactNode;
}) {
  const [descOpen, setDescOpen] = useState(true);
  const catActive = product.category && product.category.status === "active";

  return (
    <>
      <nav className="gpdp-breadcrumb">
        <Link href="/">Home</Link>
        <span>/</span>
        <Link href="/shop">Shop</Link>
        {catActive && (
          <>
            <span>/</span>
            <span className="gpdp-breadcrumb-cat">
              {product.category!.name}
            </span>
          </>
        )}
        <span>/</span>
        <span className="gpdp-breadcrumb-current">{product.name}</span>
      </nav>

      <div className="gpdp-grid">
        {/* Gallery */}
        <div className="gpdp-gallery">
          <button
            type="button"
            className="gpdp-main-img"
            onClick={() => activeImg && onZoom()}
            aria-label="Zoom image"
          >
            {activeImg ? (
              <Image
                src={activeImg}
                alt={product.name}
                fill
                sizes="(max-width: 860px) 100vw, 560px"
                className="gpdp-main-img-el"
                priority
              />
            ) : (
              <div className="gpdp-img-placeholder">
                <ImageIcon size={44} strokeWidth={1.5} aria-hidden />
              </div>
            )}
          </button>
          {gallery.length > 1 && (
            <div className="gpdp-thumbs">
              {gallery.map((url) => (
                <button
                  key={url}
                  className={`gpdp-thumb${activeImg === url ? " active" : ""}`}
                  onClick={() => setActiveImg(url)}
                  aria-label="View image"
                >
                  <Image
                    src={url}
                    alt=""
                    fill
                    sizes="72px"
                    className="gpdp-thumb-el"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="gpdp-info">
          {catActive && (
            <span className="gpdp-category">{product.category!.name}</span>
          )}
          <h1 className="gpdp-name">{product.name}</h1>

          {/* Same statement as the classic PDP — a shopper is entitled to it
              before they pay, whichever storefront layout they're on. */}
          {product.returnable === false && (
            <div className="mb-2 inline-block rounded-sm bg-zinc-100 px-2 py-1 text-xs font-bold uppercase tracking-wider text-zinc-600">
              Final sale · no returns
            </div>
          )}

          <a href="#reviews" className="gpdp-rating">
            <RatingStars value={averageRating} size={18} />
            {reviewCount > 0 ? (
              <span>
                <strong>{averageRating.toFixed(1)}</strong> · {reviewCount}{" "}
                {reviewCount === 1 ? "review" : "reviews"}
              </span>
            ) : (
              <span>No reviews yet</span>
            )}
          </a>

          {/* Purchase card */}
          <div className="gpdp-buybox">
            <div className="gpdp-price">
              <span className="gpdp-price-sell">{formatPrice(selling)}</span>
              {discount > 0 && (
                <>
                  <span className="gpdp-price-base">{formatPrice(base)}</span>
                  <span className="gpdp-price-off">{discount}% off</span>
                </>
              )}
            </div>
            <p className="gpdp-price-note">Inclusive of all taxes</p>

            {hasVariants && (
              <div className="gpdp-variants">
                {product.variants.map((v) => {
                  const disabled = v.stock <= 0;
                  const hasSale = hasSpecialPrice(v);
                  return (
                    <button
                      key={v.id}
                      className={`gpdp-variant${variantId === v.id ? " active" : ""}${
                        disabled ? " disabled" : ""
                      }`}
                      onClick={() => !disabled && selectVariant(v)}
                      disabled={disabled}
                    >
                      {v.name}
                      {hasSale && (
                        <span className="gpdp-variant-tag">Deal</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {deliveryEstimator}

            <div className="gpdp-actions">
              <div className="gpdp-stepper" aria-label="Quantity">
                <button
                  type="button"
                  onClick={() => setQuantity(Math.max(1, qty - 1))}
                  disabled={outOfStock || qty <= 1}
                  aria-label="Decrease quantity"
                >
                  −
                </button>
                <span aria-live="polite">{qty}</span>
                <button
                  type="button"
                  onClick={() => setQuantity(Math.min(maxQty, qty + 1))}
                  disabled={outOfStock || qty >= maxQty}
                  aria-label="Increase quantity"
                >
                  +
                </button>
              </div>
              <button
                className="gpdp-btn gpdp-btn-cart"
                onClick={onAddToCart}
                disabled={outOfStock}
              >
                {outOfStock ? "Out of stock" : "Add to cart"}
              </button>
            </div>

            <button
              className="gpdp-btn gpdp-btn-buy"
              onClick={onBuyNow}
              disabled={outOfStock}
            >
              Buy now
            </button>

            <div className="gpdp-trust">
              <span>
                <Truck size={16} aria-hidden /> PIN-code delivery
              </span>
              <span>
                <RotateCcw size={16} aria-hidden /> Easy returns
              </span>
              <span>
                <Sprout size={16} aria-hidden /> Farm sourced
              </span>
            </div>
          </div>

          {product.description && (
            <div className={`gpdp-desc${descOpen ? " open" : ""}`}>
              <button
                type="button"
                className="gpdp-desc-toggle"
                onClick={() => setDescOpen((o) => !o)}
                aria-expanded={descOpen}
              >
                Description
                <Minus size={20} className="gpdp-desc-icon" aria-hidden />
              </button>
              {descOpen && (
                <p className="gpdp-desc-body">{product.description}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
