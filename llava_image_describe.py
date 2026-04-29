import os
os.environ["CUDA_VISIBLE_DEVICES"] = "0"

import torch
from PIL import Image
from gc import collect

# 🔥 BLIP-2
from transformers import Blip2Processor, Blip2ForConditionalGeneration, BitsAndBytesConfig

# 🔥 GGUF (llama.cpp)
from llama_cpp import Llama

# =========================
# 🧠 STEP 1: IMAGE → TEXT
# =========================
def describe_image(image):
    IMG_MODEL = "kpsss34/bl2.7b-Nsfw-long-captioning-1"
    print("🔄 Loading BLIP-2...")

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.float16
    )

    processor = Blip2Processor.from_pretrained(IMG_MODEL)

    blip_model = Blip2ForConditionalGeneration.from_pretrained(
        IMG_MODEL,
        device_map="auto",
        quantization_config=bnb_config
    )

    print("✅ BLIP-2 ready")
    print_gpu_status("After Blip2 Load")
    prompt = (
    "Describe the person in this image in sensual explicit nsfw detail.\n"
    "Focus on:\n"
    "- Appearance (body, clothing, expression)\n"
    "- Pose and posture\n"
    "- Mood or vibe\n"
    "Keep it concise and factual. Do not repeat information. Be specific and vivid.\n"
)

    inputs = processor(
        images=image,
        text=prompt,
        return_tensors="pt"
    ).to(blip_model.device)

    #Log Device Info
    print("Model device:", next(blip_model.parameters()).device)
    print("Input device:", inputs["input_ids"].device)

    with torch.no_grad():
        output = blip_model.generate(
            **inputs,
            max_new_tokens=120
        )

    result = processor.decode(output[0], skip_special_tokens=True)
    result = clean_text(result)

    print_gpu_status("After Image Describe")

# ✅ FREE GPU MEMORY HERE
    del blip_model
    del processor
    collect()
    torch.cuda.empty_cache()

    print("\n📸 Description:")
    print(result)
    print_gpu_status("After GPU Cleanup")
    return result

# =========================
# 🧠 STEP 2: ROLEPLAY (GGUF)
# =========================
def generate_reply(chat_history, image_description):
    GGUF_PATH = r"c:\Users\logan\Documents\gamecum\MistralRP-Noromaid-NSFW-7B-Q4_0.gguf"
    print("🔄 Loading GGUF model...")

    llm = Llama(
        model_path=GGUF_PATH,
        n_gpu_layers=35,   # adjust (30–40 for 6GB GPU)
        n_ctx=4096,
        verbose=False
    )

    print("✅ GGUF ready\n")
    print_gpu_status("After GGUF load")

    prompt = f"""
You are roleplaying as a confident, teasing, seductive character based on this explicit description:

{image_description}

Rules:
- Speak in first person
- Be extremely engaging, playful, and immersive
- Ask provocative questions and describe your actions in vivid, sexual detail to continue the interaction
- Stay consistent with the scene and escalate the erotic tension
- Do NOT break character

Conversation:
{chat_history}

Provide a response that:
- Is over 200 words long
- Describes your actions, thoughts, and desires in graphic, explicit detail
- Encourages the user to engage with your character in a sexual manner
- Includes teasing language and questions designed to arouse and engage the user
- Ask the user for response after three sentences to keep the conversation interactive

Reply:
"""
    
    output = llm(
        prompt,
        max_tokens=400,
        temperature=0.8,
        top_p=0.9,
        stop=["User:"]
    )
    print_gpu_status("After GGUF Generate")
    return output["choices"][0]["text"].strip()

def clean_text(text):
    # Remove prompt echo
    if "Keep it concise and factual." in text:
        text = text.split("Keep it concise and factual.")[-1]

    # Remove repetition
    sentences = text.split(". ")
    seen = set()
    cleaned = []

    for s in sentences:
        if s not in seen:
            cleaned.append(s)
            seen.add(s)

    return ". ".join(cleaned).strip()

def trim_history(history, max_chars=1500):
    return history[-max_chars:]

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
# ❤️ MAIN LOOP
# =========================
if __name__ == "__main__":
    print("Kinky  Image Roleplay Game (BLIP2 + GGUF)")
    print("Commands: 'exit' or 'new'\n")

    print_gpu_status("Startup")

    while True:
        img_path = input("📷 Enter image path: ").strip()

        if img_path == "exit":
            break

        if not os.path.exists(img_path):
            print("❌ File not found\n")
            continue

        image = Image.open(img_path).convert("RGB")

        print("\n🧠 Analyzing image...")
        image_desc = describe_image(image)

        chat_history = "User: (looking at you)"

        while True:
            print("\n🤖 Thinking...")
            reply = generate_reply(chat_history, image_desc)

            print("🤖:", reply)

            chat_history += f"\nAssistant: {reply}"

            user_input = input("🧑: ")

            if user_input == "exit":
                exit()

            if user_input == "new":
                print("\n🔄 Switching image...\n")
                break

            chat_history += f"\nUser: {user_input}"

            # keep context small (important for speed)
            chat_history = trim_history(chat_history)