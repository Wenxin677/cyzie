# Python Basics — Values and Loops

## Variables and Types

A variable is a name that points at a value.
An integer is a whole number; a string is text in quotes.

```python
total = 0
name = "Ada"
```

## Loops over a Range

A for loop repeats a block once for each value the range produces.

```python
for i in range(1, 4):
    print(i)
```

Output: 1 2 3

## Lists and Accumulation

A list holds several values in order, and a running total is built by adding to it inside the loop.

```python
numbers = [1, 2, 3]
total = 0
for n in numbers:
    total = total + n
print(total)
```

## Functions

A function is a named block of code you can call with arguments.
The return statement hands a value back to the caller.

```python
def double(x):
    return x * 2
```
