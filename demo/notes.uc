// notes.uc -- a small tour of ucode + the fs module.
// Run it from the REPL with the "Run demo" button, or:
//     let fs = require("fs"); print(fs.readfile("/demo/notes.uc") + "\n");

// NB: ucode's print() does NOT add a trailing newline, so every call
// below passes "\n" explicitly.

let fs = require("fs");

print("== ucode demo ==\n");

// basic types and arithmetic
let x = 10;
let s = "world";
print("greeting:  hello", s, "\n");
print("arith:     2 ** 10 =", 2 ** 10, "\n");

// a named function and an anonymous one
function twice(n) {
    return n * 2;
}
let add = function(a, b) {
    return a + b;
};
print("twice(21):  ", twice(21), "\n");
print("add(3, 4):  ", add(3, 4), "\n");

// a classic for loop
for (let i = 1; i <= 3; i = i + 1) {
    print("count:", i, "\n");
}

// a while loop
let n = 0;
while (n < 2) {
    n = n + 1;
}
print("looped until n =", n, "\n");

// working with the virtual filesystem
print("files in /demo:\n");
let entries = fs.lsdir("/demo");
for (let i = 0; i < length(entries); i = i + 1) {
    print("   ", entries[i], "\n");
}

let st = fs.stat("/demo/hello.txt");
print("hello.txt size:", st.size, "type:", st.type, "\n");

// sum the numbers file line by line
let fp = fs.open("/demo/data/numbers.txt", "r");
let total = 0;
let line = fp.read("line");
while (length(line) > 0) {
    total = total + int(line);
    line = fp.read("line");
}
fp.close();
print("sum of numbers.txt:", total, "\n");

// parse JSON from a file
let people = json(fs.readfile("/demo/data/people.json"));
print("people:", length(people), "\n");
for (let i = 0; i < length(people); i = i + 1) {
    let p = people[i];
    print("   ", p.name, "(age", p.age, ", " + p.role + ")", "\n");
}

print("== done ==\n");
