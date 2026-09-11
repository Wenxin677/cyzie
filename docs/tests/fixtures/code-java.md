# CS 101 — Loops in Java

Week 3 slides. By the end of this session you should be able to write a while loop, trace a for loop, and spot an off-by-one error.

## Contents

- While loops and their conditions
- For loops and counters
- Common loop mistakes

## While Loops

A while loop repeats a block while a condition stays true.
The condition is checked before each pass, so a while loop can run zero times.

```java
int count = 0;
while (count < 5) {
  System.out.println("Pass " + count);
  count++;
}
```

Output: Pass 0 Pass 1 Pass 2 Pass 3 Pass 4

## For Loops

A for loop packs the counter, the condition and the update into one line.
Use a for loop when you know how many times the body should run.

```java
for (int i = 0; i < 4; i++) {
  System.out.println(i);
}
```

Output: 0 1 2 3

## Common Loop Mistakes

- Off by one: using <= instead of < makes the loop run one extra time.
- Forgetting to update the counter: the condition never becomes false, so the loop never ends.
- A while loop whose condition is false at the start runs zero times, not once.
