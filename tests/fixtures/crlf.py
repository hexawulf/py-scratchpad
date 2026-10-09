# Saved on Windows: every line ends with CR LF.
import sys

def main():
    print("argv:", sys.argv[1:])
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
