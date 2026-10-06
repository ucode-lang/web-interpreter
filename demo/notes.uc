// notes.uc -- a small tour of ucode + the fs module.
// Run it from the REPL with the "Run demo" button, or:
//     let fs = require("fs"); print(fs.readfile("/demo/notes.uc") + "\n");

// NB: ucode's print() writes its arguments verbatim -- no separator
// between them and no trailing newline. For formatted output, use
// printf("... %s ...\n", ...) or backtick template literals, which
// interpolate ${...} expressions.

let fs = require("fs");

print("== ucode demo ==\n");

// basic types and arithmetic
let x = 10;
let s = "world";
printf("greeting:  hello %s\n", s);
printf("arith:     2 ** 10 = %d\n", 2 ** 10);

// a named function and an anonymous one
function twice(n) {
    return n * 2;
}
let add = function(a, b) {
    return a + b;
};
print(`twice(21):  ${twice(21)}\n`);
print(`add(3, 4):  ${add(3, 4)}\n`);

// a classic for loop
for (let i = 1; i <= 3; i = i + 1) {
    printf("count: %d\n", i);
}

// a while loop
let n = 0;
while (n < 2) {
    n = n + 1;
}
printf("looped until n = %d\n", n);

// working with the virtual filesystem
print("files in /demo:\n");
let entries = fs.lsdir("/demo");
for (let i = 0; i < length(entries); i = i + 1) {
    print("   ", entries[i], "\n");
}

let st = fs.stat("/demo/hello.txt");
printf("hello.txt size: %d, type: %s\n", st.size, st.type);

// sum the numbers file line by line
let fp = fs.open("/demo/data/numbers.txt", "r");
let total = 0;
let line = fp.read("line");
while (length(line) > 0) {
    total = total + int(line);
    line = fp.read("line");
}
fp.close();
printf("sum of numbers.txt: %d\n", total);

// parse JSON from a file
let people = json(fs.readfile("/demo/data/people.json"));
printf("people: %d\n", length(people));
for (let i = 0; i < length(people); i = i + 1) {
    let p = people[i];
    print(`   ${p.name} (age ${p.age}, ${p.role})\n`);
}

print("== done ==\n");