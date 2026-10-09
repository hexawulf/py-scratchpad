"""Indented with four spaces, PEP 8 style."""


def total(prices):
    """Return the sum of prices, ignoring None entries."""
    running = 0
    for price in prices:
        if price is not None:
            running += price
    return running


if __name__ == "__main__":
    print(total([1, None, 2.5]))
