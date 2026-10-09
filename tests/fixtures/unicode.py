# Non-ASCII on purpose: accents, CJK, emoji, combining marks.
MESSAGE = "héllo — 日本語 🐍 añejo é"
NAMES = ["Zoë", "Müller", "Ωμέγα", "Привет"]


def shout(text):
    """Return text in upper case with a snake tail."""
    return f"{text.upper()} 🐍"


if __name__ == "__main__":
    print(shout(MESSAGE))
    for name in NAMES:
        print(name, len(name))
