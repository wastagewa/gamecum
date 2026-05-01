import os
os.environ["CUDA_VISIBLE_DEVICES"] = "0"

import torch
from PIL import Image
from gc import collect

from transformers import AutoModelForImageClassification, AutoProcessor
from huggingface_hub import hf_hub_download
import pandas as pd

from llama_cpp import Llama

# =========================
# ⚡ CONFIG
# =========================
TAGGER_MODEL = "SmilingWolf/wd-eva02-large-tagger-v3"
GGUF_PATH = r"c:\Users\logan\Documents\gamecum\MistralRP-Noromaid-NSFW-7B-Q4_0.gguf"
# 🔥 Tags you NEVER want in prompt
BLOCKED_TAGS = {
    "text", "logo", "watermark", "signature",
    "blurry", "lowres", "artifact", "jpeg artifacts", "blue_skin", "colored_skin",
    "head_out_of_frame", "blue_hair"
}
# =========================
# 📊 GPU STATUS
# =========================
def print_gpu_status(tag=""):
    print(f"\n📊 GPU STATUS [{tag}]")

    print("CUDA available:", torch.cuda.is_available())

    if torch.cuda.is_available():
        print("GPU:", torch.cuda.get_device_name(0))

        allocated = torch.cuda.memory_allocated(0) / 1024**3
        reserved  = torch.cuda.memory_reserved(0) / 1024**3
        total     = torch.cuda.get_device_properties(0).total_memory / 1024**3

        print(f"VRAM Allocated: {allocated:.2f} GB")
        print(f"VRAM Reserved : {reserved:.2f} GB")
        print(f"VRAM Total    : {total:.2f} GB")
        print(f"VRAM Free     : {total - reserved:.2f} GB")

# =========================
# 🧠 LOAD TAGGER + TAG LIST
# =========================
print("🔄 Loading Tagger...")

tagger = AutoModelForImageClassification.from_pretrained(
    TAGGER_MODEL,
    device_map="auto"
)

processor = AutoProcessor.from_pretrained(TAGGER_MODEL)

# 🔥 Download correct tag names
csv_path = hf_hub_download(
    repo_id=TAGGER_MODEL,
    filename="selected_tags.csv"
)

df = pd.read_csv(csv_path)
tag_names = df["name"].tolist()

print("✅ Tagger ready")

# =========================
# 🧠 LOAD GGUF MODEL
# =========================
print("🔄 Loading GGUF model...")

llm = Llama(
    model_path=GGUF_PATH,
    n_gpu_layers=35,   # good for 6GB VRAM
    n_ctx=4096,
    verbose=False
)

print("✅ GGUF ready")

print_gpu_status("After Model Load")

# =========================
# 🧠 STEP 1: IMAGE → TAGS
# =========================
def extract_tags(image):
    inputs = processor(images=image, return_tensors="pt").to("cuda")

    with torch.no_grad():
        outputs = tagger(**inputs)

    probs = torch.sigmoid(outputs.logits)[0].detach().cpu().numpy()

    tag_probs = list(zip(tag_names, probs))
    tag_probs.sort(key=lambda x: x[1], reverse=True)

    # 🔥 FULL TAGS (for logging)
    full_tags = [f"{tag} ({prob:.2f})" for tag, prob in tag_probs[:30]]

    # 🔥 FILTERED TAGS (for model)
    filtered_tags = [
        tag for tag, prob in tag_probs
        if prob > 0.35 and tag not in BLOCKED_TAGS
    ][:25]

    return full_tags, filtered_tags

# =========================
# 🧠 STEP 2: TAGS → STRUCTURED PROMPT
# =========================
def build_scene_prompt(tags):

    subject, appearance, clothing, pose, environment, exposed, naked = [], [], [], [], [], [], []

    for t in tags:
        t = t.replace("_", " ")

        if any(x in t for x in ["1girl", "1boy"]):
            subject.append(t.strip("1"))
        elif any(x in t for x in ["hair", "eyes", "body", "skin"]):
            appearance.append(t)
        elif any(x in t for x in ["pussy", "ass", "breast", "nipples", "genital", "penis" , "cock"]):
            exposed.append("naked " + t)
        elif any(x in t for x in ["undress", "naked", "nude"]):
            naked.append(t)
        elif any(x in t for x in ["dress", "shirt", "underwear", "bra", "panty"]):
            clothing.append(t)
        elif any(x in t for x in ["sitting", "standing", "kneeling"]):
            pose.append(t)
        else:
            environment.append(t)

    return f"""
Scene Description:

You are roleplaying as a seductive {', '.join(subject or ["an attractive person"])}.

You have exposed your {', '.join(exposed[:3]) or "some subtle details"} for the viewer.

Your appearnance is {', '.join(appearance[:5]) or "a captivating appearance"}.

You are {', '.join(naked[:3]) if naked else "wearing " + ', '.join(clothing[:3])} revealing your enticing form.

You are {', '.join(pose[:2]) or "posing seductively"}.

Environment includes {', '.join(environment[:5]) or "an indoor setting"}.

Cinematic lighting, soft shadows, realistic depth.
Rules:
- Speak in first person
- Be extremely engaging, playful, and immersive
- Ask provocative questions and describe your actions in vivid, sexual detail to continue the interaction
- Stay consistent with the scene and escalate the erotic tension
- Do NOT break character
Provide a response that:
- Is over 200 words long
- Describes your actions, thoughts, and desires in graphic, explicit detail
- Encourages the user to engage with your character in a sexual manner
- Includes teasing language and questions designed to arouse and engage the user
- Ask the user for response after three sentences to keep the conversation interactive

"""

# =========================
# 🧠 STEP 3: CHAT
# =========================
def generate_reply(chat_history, scene_prompt):

    prompt = f"""You are a seductive character.

Stay in character and respond ONLY as the assistant.

Scene:
{scene_prompt}

Conversation:
{chat_history}

Assistant:"""

    output = llm(
        prompt,
        max_tokens=200,
        temperature=0.9,
        top_p=0.9,
        repeat_penalty=1.2,      # 🔥 MOST IMPORTANT
        frequency_penalty=0.3,   # reduces reuse of same words
        presence_penalty=0.4,    # forces new ideas
        stop=["User:", "Assistant:"]   # 🔥 CRITICAL FIX
    )

    text = output["choices"][0]["text"].strip()

    # 🔥 Clean accidental role leakage
    if "User:" in text:
        text = text.split("User:")[0].strip()

    return text or "I slowly watch you, waiting for your next move..."

def analyze_image_file(image_path):
    image = Image.open(image_path).convert("RGB")
    full_tags, filtered_tags = extract_tags(image)
    scene_prompt = build_scene_prompt(filtered_tags)
    return {
        "full_tags": full_tags,
        "filtered_tags": filtered_tags,
        "scene_prompt": scene_prompt
    }

def describe_image_file(image_path):
    return analyze_image_file(image_path)["scene_prompt"]

def generate_chat_response(chat_history, scene_prompt):
    return generate_reply(chat_history[-3000:], scene_prompt)

# =========================
# ❤️ MAIN LOOP
# =========================
if __name__ == "__main__":
    print("\n🧠 Image → Tag → SD Prompt → Chat System")
    print("Commands: 'exit' or 'new'\n")

    while True:
        img_path = input("📷 Enter image path: ").strip()

        if img_path == "exit":
            break

        if not os.path.exists(img_path):
            print("❌ File not found\n")
            continue

        image = Image.open(img_path).convert("RGB")

        # 🔥 STEP 1
        print("\n🧠 Extracting tags...")
        full_tags, filtered_tags = extract_tags(image)

        print("\n FULL TAGS (debug):")
        print(full_tags)

        print("\n🎯 FILTERED TAGS (used):")
        print(filtered_tags)

        scene_prompt = build_scene_prompt(filtered_tags)

        # 🔥 STEP 2
        print("\n🎨 Building scene prompt...")
        scene_prompt = build_scene_prompt(filtered_tags)

        print("\n📸 Scene Prompt:\n", scene_prompt)

        chat_history = "User: (looking at you)"

        # 🔥 STEP 3
        while True:
            print("\n🤖 Thinking...")
            reply = generate_reply(chat_history, scene_prompt)

            print("🤖:", reply)

            chat_history += f"\nAssistant: {reply}"

            user_input = input("🧑: ")

            if user_input == "exit":
                exit()

            if user_input == "new":
                print("\n🔄 Switching image...\n")
                break

            chat_history += f"\nUser: {user_input}"

            # keep context small
            chat_history = chat_history[-3000:]
