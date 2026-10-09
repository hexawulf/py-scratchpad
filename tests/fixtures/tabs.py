# Indented with real tab characters, not spaces.
def classify(n):
	if n < 0:
		return "negative"
	elif n == 0:
		return "zero"
	return "positive"


if __name__ == "__main__":
	for value in (-2, 0, 7):
		print(value, classify(value))
