"""Bayesian logistic and softmax regression (MAP + Laplace approximation), numpy only.

The Gaussian prior is the regulariser: precision `l2` on standardised features, optionally
centred at a non-zero prior mean. The Laplace covariance gives per-prediction logit
uncertainty, which feeds the confidence measure.
"""
from __future__ import annotations

import warnings

import numpy as np


class Standardizer:
    """Fitted on training rows only. Imputes unknowns with the training mean (recorded)."""

    def fit(self, X: np.ndarray) -> "Standardizer":
        with warnings.catch_warnings(), np.errstate(all="ignore"):
            warnings.simplefilter("ignore", RuntimeWarning)
            self.mean = np.nan_to_num(np.nanmean(X, axis=0)) if len(X) else np.zeros(X.shape[1])
            sd = np.nanstd(X, axis=0) if len(X) else np.ones(X.shape[1])
        sd = np.nan_to_num(sd)
        self.active = sd > 1e-9            # constant/unknown-everywhere features carry no information
        self.sd = np.where(self.active, sd, 1.0)
        return self

    def transform(self, X: np.ndarray) -> np.ndarray:
        Z = (X - self.mean) / self.sd
        Z = np.where(np.isnan(Z), 0.0, Z)  # 0 in standardised units == training mean
        return Z * self.active

    def to_dict(self):
        return {"mean": self.mean.tolist(), "sd": self.sd.tolist(), "active": self.active.astype(int).tolist()}

    @classmethod
    def from_dict(cls, d):
        s = cls()
        s.mean, s.sd, s.active = np.array(d["mean"]), np.array(d["sd"]), np.array(d["active"]).astype(bool)
        return s


def _sig(z):
    return 1 / (1 + np.exp(-np.clip(z, -35, 35)))


def fit_logistic(Z: np.ndarray, y: np.ndarray, l2: float = 1.0, prior_mean: np.ndarray | None = None,
                 weights: np.ndarray | None = None, max_iter: int = 50, tol: float = 1e-8) -> dict:
    """Newton-Raphson MAP for p(y=1) = σ(Z·w) with prior N(prior_mean, 1/l2). No intercept."""
    n, d = Z.shape
    w0 = np.zeros(d) if prior_mean is None else np.asarray(prior_mean, float)
    sw = np.ones(n) if weights is None else np.asarray(weights, float)
    w = w0.copy()
    I = np.eye(d)
    for it in range(max_iter):
        p = _sig(Z @ w)
        g = Z.T @ (sw * (p - y)) + l2 * (w - w0)
        H = (Z * (sw * p * (1 - p))[:, None]).T @ Z + l2 * I
        step = np.linalg.solve(H, g)
        w -= step
        if np.max(np.abs(step)) < tol:
            break
    p = _sig(Z @ w)
    H = (Z * (sw * p * (1 - p))[:, None]).T @ Z + l2 * I
    cov = np.linalg.inv(H)
    nll = -np.sum(sw * (y * np.log(np.clip(p, 1e-12, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-12, 1))))
    return {"w": w, "cov": cov, "iters": it + 1, "nll": float(nll), "n": int(n)}


def fit_softmax(Z: np.ndarray, Y: np.ndarray, l2: float = 1.0, max_iter: int = 300, lr: float = 0.5,
                class_prior: np.ndarray | None = None) -> dict:
    """Multinomial logistic with intercepts (intercepts lightly regularised). Y is one-hot (n, k)."""
    n, d = Z.shape
    k = Y.shape[1]
    Za = np.hstack([np.ones((n, 1)), Z])
    W = np.zeros((d + 1, k))
    if class_prior is not None:
        W[0] = np.log(np.clip(class_prior, 1e-6, 1))
    reg = np.full((d + 1, 1), l2)
    reg[0] = 1e-3
    # L-BFGS would be faster; plain gradient descent with backtracking is adequate at this scale
    def loss_grad(W):
        S = Za @ W
        S -= S.max(axis=1, keepdims=True)
        P = np.exp(S)
        P /= P.sum(axis=1, keepdims=True)
        loss = -np.sum(Y * np.log(np.clip(P, 1e-12, 1))) / n + 0.5 * np.sum(reg * W * W) / n
        grad = Za.T @ (P - Y) / n + reg * W / n
        return loss, grad
    loss, grad = loss_grad(W)
    for _ in range(max_iter):
        step = lr
        while True:
            Wn = W - step * grad
            ln, gn = loss_grad(Wn)
            if ln <= loss - 0.25 * step * np.sum(grad * grad) or step < 1e-6:
                break
            step *= 0.5
        if abs(loss - ln) < 1e-9:
            W, loss, grad = Wn, ln, gn
            break
        W, loss, grad = Wn, ln, gn
    return {"W": W, "loss": float(loss)}


def softmax_predict(W: np.ndarray, Z: np.ndarray) -> np.ndarray:
    Za = np.hstack([np.ones((Z.shape[0], 1)), Z])
    S = Za @ W
    S -= S.max(axis=1, keepdims=True)
    P = np.exp(S)
    return P / P.sum(axis=1, keepdims=True)
