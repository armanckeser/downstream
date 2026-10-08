"""A tiny module used to test sending a review to a pull request."""


def total(prices):
    """Sum of prices in cents."""
    return sum(prices)


def discounted(prices, pct):
    return total(prices) * (100 - pct) / 100
